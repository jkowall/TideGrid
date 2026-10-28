/**
 * The scripted custom-hostname provider (G2.14b demo shim): an in-memory
 * stand-in for Cloudflare for SaaS behind the neutral adapter. Nothing leaves
 * the process and no DNS or certificate is ever touched.
 *
 * - Deterministic: ids run `fake-ch-0001`, `fake-ch-0002`, and so on, the
 *   validation tokens derive from the id, and the clock is injectable.
 * - Cloudflare-shaped: records carry Cloudflare's own status strings, and the
 *   states come from the same mapping the real client uses (`status.ts`).
 * - Scripted: one-shot faults (`failNext`, `timeoutNext`, `loseNextAnswer`),
 *   DNS that already routes (`cnamePresent`), records made outside TideGrid
 *   (`plantRecord`), and state changes (`advance`), so tests and the demo can
 *   walk every branch of the hostname lifecycle.
 */
import {
  type CertificateState,
  type CertificateValidation,
  type CustomHostnameProvider,
  type HostnameInstruction,
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
  type HostnameState,
  type ProviderHostname,
} from "./provider.ts";
import { mapCloudflareCertificateStatus, mapCloudflareHostnameStatus } from "./status.ts";

/** Provider ids as TideGrid stores them. Both providers refuse anything else. */
export const providerIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** A Cloudflare status string for each state, so scripted records stay realistic. */
export const fakeRawStatus: {
  hostname: Readonly<Record<HostnameState, string>>;
  certificate: Readonly<Record<CertificateState, string>>;
} = {
  hostname: {
    pending: "pending",
    active: "active",
    moved: "moved",
    blocked: "blocked",
    deleted: "deleted",
    // Any string the mapping does not list reads as unknown.
    unknown: "unlisted_status",
  },
  certificate: {
    pending: "pending_validation",
    active: "active",
    expiring: "pending_expiration",
    failed: "validation_timed_out",
    unknown: "unlisted_status",
  },
};

/** A state change for a stored record. Raw status strings follow the states. */
export interface HostnameAdvance {
  hostnameState?: HostnameState;
  certificateState?: CertificateState;
  /** Replaces the record's error codes. */
  errors?: string[];
}

/** The scripted controls shared by the fake and the Cloudflare fixture. */
export interface HostnameProviderControls {
  /** Change a stored record's states. Throws when no record holds the name. */
  advance(hostname: string, change: HostnameAdvance): void;
  /** The next call throws `HostnameProviderUnavailableError(status)` and has no effect. */
  failNext(fault: { status: 429 | 500 | 503; retryAfterSeconds?: number }): void;
  /** The next `create` takes effect at the provider, but its answer is lost. */
  loseNextAnswer(): void;
  /** The next call times out with no effect. */
  timeoutNext(): void;
  /** DNS for the name already routes to the target: validation passes at once. */
  cnamePresent(hostname: string): void;
  /** A record already in the zone, made outside TideGrid when `foreign`. */
  plantRecord(hostname: string, options?: { foreign?: boolean }): void;
}

export interface FakeHostnameRecord {
  providerId: string;
  hostname: string;
  hostnameStatus: string;
  certificateStatus: string;
  certificateValidation: CertificateValidation;
  errors: string[];
  /** Made outside TideGrid, as a planted record can be. */
  foreign: boolean;
  createdAt: Date;
}

export interface FakeHostnameCall {
  method: string;
  hostname?: string;
  providerId?: string;
}

export interface FakeHostnameOptions {
  clock?: () => Date;
  /** The CNAME target. Defaults to `customers.tidegrid.us`. */
  routingTarget?: string;
  /**
   * The start of every id, `fake-ch` by default. The database keeps provider
   * ids unique, so a fake in a process that shares a database with earlier
   * fakes (the admin CLI) passes a prefix of its own.
   */
  idPrefix?: string;
}

export interface FakeHostnameProvider extends CustomHostnameProvider, HostnameProviderControls {
  readonly name: "fake";
  /** Every provider call in order, faulted ones included. */
  readonly calls: FakeHostnameCall[];
  /** A copy of every stored record, in creation order. */
  records(): FakeHostnameRecord[];
}

/** A one-shot fault. A null status is a timeout or a dropped connection. */
type Fault = { status: number | null; retryAfterSeconds: number | null };

const hostnamePattern = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** A stored or requested name must already be in normalized form. */
export function checkProviderHostname(hostname: unknown): string {
  if (typeof hostname !== "string" || !hostnamePattern.test(hostname)) {
    throw new HostnameProviderRejectedError("invalid_hostname");
  }
  return hostname;
}

export function checkProviderId(providerId: unknown): string {
  if (typeof providerId !== "string" || !providerIdPattern.test(providerId)) {
    throw new HostnameProviderRejectedError("invalid_provider_id");
  }
  return providerId;
}

/** A UUID-shaped token derived from a sequence number, so runs repeat exactly. */
function deterministicUuid(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

class ScriptedHostnameProvider implements FakeHostnameProvider {
  readonly name = "fake" as const;
  readonly calls: FakeHostnameCall[] = [];
  readonly #clock: () => Date;
  readonly #target: string;
  readonly #records = new Map<string, FakeHostnameRecord & { sequence: number }>();
  readonly #routed = new Set<string>();
  readonly #faults: Fault[] = [];
  #loseNextCreate = false;
  #sequence = 0;
  readonly #idPrefix: string;

  constructor(options: FakeHostnameOptions) {
    this.#idPrefix = options.idPrefix ?? "fake-ch";
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(this.#idPrefix)) {
      throw new TypeError("a fake id prefix is 1 to 40 letters, digits, hyphens, or underscores");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#target = checkProviderHostname(options.routingTarget ?? "customers.tidegrid.us");
  }

  routingTarget(): string {
    return this.#target;
  }

  async create(input: {
    hostname: string;
    certificateValidation?: CertificateValidation;
  }): Promise<ProviderHostname> {
    this.#enter("create", { hostname: input.hostname });
    const hostname = checkProviderHostname(input.hostname);
    if (this.#byName(hostname)) throw new HostnameProviderRejectedError("already_exists");
    const record = this.#store(hostname, input.certificateValidation ?? "txt", false);
    if (this.#routed.has(hostname)) {
      record.hostnameStatus = fakeRawStatus.hostname.active;
      record.certificateStatus = fakeRawStatus.certificate.active;
    }
    if (this.#loseNextCreate) {
      this.#loseNextCreate = false;
      throw new HostnameProviderUnavailableError(null);
    }
    return this.#read(record);
  }

  async get(providerId: string, expectedHostname: string): Promise<ProviderHostname | null> {
    this.#enter("get", { providerId, hostname: expectedHostname });
    const record = this.#records.get(checkProviderId(providerId));
    if (!record) return null;
    if (record.hostname !== expectedHostname) {
      throw new HostnameProviderRejectedError("hostname_mismatch");
    }
    return this.#read(record);
  }

  async findByHostname(hostname: string): Promise<ProviderHostname | null> {
    this.#enter("findByHostname", { hostname });
    const record = this.#byName(checkProviderHostname(hostname));
    return record ? this.#read(record) : null;
  }

  async refreshValidation(providerId: string, expectedHostname: string): Promise<ProviderHostname> {
    this.#enter("refreshValidation", { providerId, hostname: expectedHostname });
    const record = this.#records.get(checkProviderId(providerId));
    if (!record) throw new HostnameProviderRejectedError("not_found");
    if (record.hostname !== expectedHostname) {
      throw new HostnameProviderRejectedError("hostname_mismatch");
    }
    // A fresh check passes once DNS routes to the target.
    if (this.#routed.has(record.hostname)) {
      record.hostnameStatus = fakeRawStatus.hostname.active;
      record.certificateStatus = fakeRawStatus.certificate.active;
      record.errors = [];
    }
    return this.#read(record);
  }

  async remove(providerId: string): Promise<void> {
    this.#enter("remove", { providerId });
    this.#records.delete(checkProviderId(providerId));
  }

  advance(hostname: string, change: HostnameAdvance): void {
    const record = this.#byName(hostname);
    if (!record) throw new Error(`the fake holds no record for ${hostname}`);
    if (change.hostnameState) record.hostnameStatus = fakeRawStatus.hostname[change.hostnameState];
    if (change.certificateState) {
      record.certificateStatus = fakeRawStatus.certificate[change.certificateState];
    }
    if (change.errors) record.errors = [...change.errors];
  }

  failNext(fault: { status: 429 | 500 | 503; retryAfterSeconds?: number }): void {
    this.#faults.push({
      status: fault.status,
      retryAfterSeconds: fault.retryAfterSeconds ?? null,
    });
  }

  loseNextAnswer(): void {
    this.#loseNextCreate = true;
  }

  timeoutNext(): void {
    this.#faults.push({ status: null, retryAfterSeconds: null });
  }

  cnamePresent(hostname: string): void {
    this.#routed.add(checkProviderHostname(hostname));
  }

  plantRecord(hostname: string, options: { foreign?: boolean } = {}): FakeHostnameRecord {
    const name = checkProviderHostname(hostname);
    if (this.#byName(name)) throw new Error(`the fake already holds ${name}`);
    return copy(this.#store(name, "txt", options.foreign ?? false));
  }

  records(): FakeHostnameRecord[] {
    return [...this.#records.values()].sort((a, b) => a.sequence - b.sequence).map(copy);
  }

  /** Log the call, then spend one scripted fault if any is queued. */
  #enter(method: string, detail: { hostname?: string; providerId?: string }): void {
    const call: FakeHostnameCall = { method };
    if (detail.hostname !== undefined) call.hostname = detail.hostname;
    if (detail.providerId !== undefined) call.providerId = detail.providerId;
    this.calls.push(call);
    const fault = this.#faults.shift();
    if (!fault) return;
    throw new HostnameProviderUnavailableError(fault.status, fault.retryAfterSeconds);
  }

  #byName(hostname: string) {
    for (const record of this.#records.values()) {
      if (record.hostname === hostname) return record;
    }
    return undefined;
  }

  #store(hostname: string, certificateValidation: CertificateValidation, foreign: boolean) {
    this.#sequence += 1;
    const record: FakeHostnameRecord & { sequence: number } = {
      providerId: `${this.#idPrefix}-${String(this.#sequence).padStart(4, "0")}`,
      hostname,
      hostnameStatus: fakeRawStatus.hostname.pending,
      certificateStatus: fakeRawStatus.certificate.pending,
      certificateValidation,
      errors: [],
      foreign,
      createdAt: this.#clock(),
      sequence: this.#sequence,
    };
    this.#records.set(record.providerId, record);
    return record;
  }

  #read(record: FakeHostnameRecord & { sequence: number }): ProviderHostname {
    const certificateState = mapCloudflareCertificateStatus(record.certificateStatus);
    const instructions: HostnameInstruction[] = [
      { kind: "cname", name: record.hostname, target: this.#target },
      {
        kind: "txt",
        name: `_cf-custom-hostname.${record.hostname}`,
        value: deterministicUuid("0c0ffee0", record.sequence),
        purpose: "ownership",
      },
    ];
    // Cloudflare drops its certificate validation records once a certificate is issued.
    if (certificateState !== "active" && certificateState !== "expiring") {
      const token = deterministicUuid("acce55ed", record.sequence);
      instructions.push(
        record.certificateValidation === "http"
          ? {
              kind: "http",
              url: `http://${record.hostname}/.well-known/acme-challenge/${token}`,
              body: token,
              purpose: "certificate",
            }
          : {
              kind: "txt",
              name: `_acme-challenge.${record.hostname}`,
              value: token,
              purpose: "certificate",
            },
      );
    }
    instructions.push({
      kind: "http",
      url: `http://${record.hostname}/.well-known/cf-custom-hostname-challenge/${record.providerId}`,
      body: deterministicUuid("0c0ffee0", record.sequence),
      purpose: "ownership",
    });
    return {
      providerId: record.providerId,
      hostname: record.hostname,
      hostnameState: mapCloudflareHostnameStatus(record.hostnameStatus),
      certificateState,
      raw: { hostnameStatus: record.hostnameStatus, certificateStatus: record.certificateStatus },
      instructions,
      errors: [...record.errors],
      checkedAt: this.#clock(),
    };
  }
}

function copy(record: FakeHostnameRecord): FakeHostnameRecord {
  return {
    providerId: record.providerId,
    hostname: record.hostname,
    hostnameStatus: record.hostnameStatus,
    certificateStatus: record.certificateStatus,
    certificateValidation: record.certificateValidation,
    errors: [...record.errors],
    foreign: record.foreign,
    createdAt: new Date(record.createdAt.getTime()),
  };
}

export function createFakeHostnameProvider(
  options: FakeHostnameOptions = {},
): FakeHostnameProvider {
  return new ScriptedHostnameProvider(options);
}
