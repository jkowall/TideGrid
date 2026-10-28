/**
 * The Cloudflare for SaaS custom-hostname client (G2.14b). It speaks to
 * `/zones/{zone_id}/custom_hostnames` over fetch and runs in workerd and in
 * Node. Until the owner enables SaaS it is tested only against the recorded
 * fixture in `cloudflare-fixture.ts`.
 *
 * - Fail closed: every answer is parsed, and anything that does not parse is
 *   `malformed_response`. Statuses go through `status.ts`, so a value
 *   Cloudflare adds later reads as unknown.
 * - Exact names only: lookups use `hostname.exact`, never `hostname.contain`
 *   or `hostname.startsWith`, and every reading must name the hostname the
 *   caller expects.
 * - The API token goes only into the Authorization header. No error message,
 *   code, or thrown value carries it, and no response text is echoed.
 *
 * API reference: https://developers.cloudflare.com/api/resources/custom_hostnames/
 * Error codes: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/reference/status-codes/custom-hostnames/
 */
import { z } from "zod";
import {
  type CertificateValidation,
  type CustomHostnameProvider,
  type HostnameInstruction,
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
  type ProviderHostname,
} from "./provider.ts";
import { mapCloudflareCertificateStatus, mapCloudflareHostnameStatus } from "./status.ts";

export interface CloudflareHostnameOptions {
  /** The SaaS zone's id: 32 lowercase hex characters. */
  zoneId: string;
  /** A token scoped to the zone's SSL and Certificates edit permission. */
  apiToken: string;
  /** The CNAME target operators point their hostnames at. */
  routingTarget: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The wait before reading a new record back. Defaults to 2000 ms. */
  delayedGetMs?: number;
  /** Each request's deadline. Defaults to 15000 ms. */
  requestTimeoutMs?: number;
  apiBase?: string;
  /** Stamps `checkedAt`. */
  clock?: () => Date;
}

const zoneIdPattern = /^[0-9a-f]{32}$/;
/** Provider ids as TideGrid stores them. Cloudflare's are 36-character UUIDs. */
const providerIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** A name goes into a body or a query only in normalized form. */
function checkHostname(hostname: unknown): string {
  if (typeof hostname !== "string" || !hostnamePattern.test(hostname)) {
    throw new HostnameProviderRejectedError("invalid_hostname");
  }
  return hostname;
}

/** An id goes into a path only when it cannot change the path. */
function checkProviderId(providerId: unknown): string {
  if (typeof providerId !== "string" || !providerIdPattern.test(providerId)) {
    throw new HostnameProviderRejectedError("invalid_provider_id");
  }
  return providerId;
}

/** Cloudflare's duplicate custom hostname error (HTTP 409). */
const duplicateCode = 1406;
/** Cloudflare's custom hostname not found error (HTTP 404). */
const notFoundCode = 1436;

const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z
    .array(z.object({ code: z.union([z.number(), z.string()]), message: z.string().optional() }))
    .nullish(),
  result: z.unknown(),
});

const customHostnameSchema = z.object({
  id: z.string().regex(providerIdPattern),
  hostname: z.string().min(1).max(255),
  status: z.string(),
  ssl: z
    .object({
      status: z.string(),
      method: z.string().nullish(),
      validation_records: z
        .array(
          z.object({
            txt_name: z.string().nullish(),
            txt_value: z.string().nullish(),
            http_url: z.string().nullish(),
            http_body: z.string().nullish(),
          }),
        )
        .nullish(),
      validation_errors: z.array(z.object({ message: z.string().nullish() })).nullish(),
    })
    .nullish(),
  ownership_verification: z
    .object({ type: z.string(), name: z.string(), value: z.string() })
    .nullish(),
  ownership_verification_http: z.object({ http_url: z.string(), http_body: z.string() }).nullish(),
  verification_errors: z.array(z.string()).nullish(),
});

type CustomHostname = z.infer<typeof customHostnameSchema>;

type Answer = { kind: "ok"; result: unknown } | { kind: "not_found" };

function malformed(): HostnameProviderRejectedError {
  return new HostnameProviderRejectedError("malformed_response");
}

/** `retry-after` in whole seconds. An HTTP date or anything else reads as absent. */
function retryAfterSeconds(headers: Headers): number | null {
  const value = headers.get("retry-after")?.trim();
  if (!value || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

function firstErrorCode(envelope: z.infer<typeof envelopeSchema> | null): number | null {
  const code = envelope?.errors?.[0]?.code;
  if (typeof code === "number" && Number.isSafeInteger(code) && code >= 0) return code;
  if (typeof code === "string" && /^\d{1,9}$/.test(code)) return Number(code);
  return null;
}

function parseEnvelope(text: string): z.infer<typeof envelopeSchema> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = envelopeSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function parseCustomHostname(value: unknown): CustomHostname {
  const parsed = customHostnameSchema.safeParse(value);
  if (!parsed.success) throw malformed();
  return parsed.data;
}

class CloudflareHostnameProvider implements CustomHostnameProvider {
  readonly name = "cloudflare_saas" as const;
  readonly #base: string;
  readonly #token: string;
  readonly #target: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #delayedGetMs: number;
  readonly #timeoutMs: number;
  readonly #clock: () => Date;

  constructor(options: CloudflareHostnameOptions) {
    if (typeof options.zoneId !== "string" || !zoneIdPattern.test(options.zoneId)) {
      throw new TypeError("a Cloudflare zone id is 32 lowercase hex characters");
    }
    if (typeof options.apiToken !== "string" || options.apiToken.trim().length === 0) {
      throw new TypeError("a Cloudflare API token is required");
    }
    const apiBase = (options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    if (!apiBase.startsWith("https://")) throw new TypeError("the Cloudflare API base is https");
    this.#base = `${apiBase}/zones/${options.zoneId}/custom_hostnames`;
    this.#token = options.apiToken;
    this.#target = checkHostname(options.routingTarget);
    // Bound to globalThis: workerd refuses a fetch called with another receiver.
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#delayedGetMs = options.delayedGetMs ?? 2000;
    this.#timeoutMs = options.requestTimeoutMs ?? 15000;
    this.#clock = options.clock ?? (() => new Date());
  }

  routingTarget(): string {
    return this.#target;
  }

  async create(input: {
    hostname: string;
    certificateValidation?: CertificateValidation;
  }): Promise<ProviderHostname> {
    const hostname = checkHostname(input.hostname);
    const body = { hostname, ssl: { method: input.certificateValidation ?? "txt", type: "dv" } };
    const posted = await this.#request("POST", "", { body });
    if (posted.kind === "not_found") throw new HostnameProviderRejectedError("http_404");
    const created = this.#expect(parseCustomHostname(posted.result), hostname);
    // The POST answer can omit validation records until Cloudflare has generated them.
    await this.#sleep(this.#delayedGetMs);
    let reread: Answer;
    try {
      reread = await this.#request("GET", `/${created.id}`);
    } catch (error) {
      // The record exists either way. Its id is worth more than a retry here.
      if (error instanceof HostnameProviderUnavailableError) return this.#reading(created);
      throw error;
    }
    if (reread.kind === "not_found") return this.#reading(created);
    const read = this.#expect(parseCustomHostname(reread.result), hostname);
    if (read.id !== created.id) throw malformed();
    return this.#reading(read);
  }

  async get(providerId: string, expectedHostname: string): Promise<ProviderHostname | null> {
    const id = checkProviderId(providerId);
    const answer = await this.#request("GET", `/${id}`);
    if (answer.kind === "not_found") return null;
    return this.#reading(this.#expect(parseCustomHostname(answer.result), expectedHostname));
  }

  async findByHostname(hostname: string): Promise<ProviderHostname | null> {
    const name = checkHostname(hostname);
    const search = new URLSearchParams({ "hostname.exact": name });
    const answer = await this.#request("GET", "", { search });
    // An empty list is the answer for no match. A 404 here means the zone itself is missing.
    if (answer.kind === "not_found") throw new HostnameProviderRejectedError("http_404");
    if (!Array.isArray(answer.result)) throw malformed();
    // Keep only exact matches, whatever the filter returned.
    const matches = answer.result.map(parseCustomHostname).filter((h) => h.hostname === name);
    if (matches.length > 1) throw new HostnameProviderRejectedError("ambiguous_hostname");
    const match = matches[0];
    return match ? this.#reading(match) : null;
  }

  async refreshValidation(providerId: string, expectedHostname: string): Promise<ProviderHostname> {
    const id = checkProviderId(providerId);
    const current = await this.#request("GET", `/${id}`);
    if (current.kind === "not_found") throw new HostnameProviderRejectedError("not_found");
    const before = this.#expect(parseCustomHostname(current.result), expectedHostname);
    const method = before.ssl?.method === "http" ? "http" : "txt";
    // A PATCH with the same validation settings makes Cloudflare check again.
    const answer = await this.#request("PATCH", `/${id}`, {
      body: { ssl: { method, type: "dv" } },
    });
    if (answer.kind === "not_found") throw new HostnameProviderRejectedError("not_found");
    return this.#reading(this.#expect(parseCustomHostname(answer.result), expectedHostname));
  }

  async remove(providerId: string): Promise<void> {
    const id = checkProviderId(providerId);
    await this.#request("DELETE", `/${id}`);
  }

  #expect(record: CustomHostname, expectedHostname: string): CustomHostname {
    if (record.hostname !== expectedHostname) {
      throw new HostnameProviderRejectedError("hostname_mismatch");
    }
    return record;
  }

  #reading(record: CustomHostname): ProviderHostname {
    const instructions: HostnameInstruction[] = [
      { kind: "cname", name: record.hostname, target: this.#target },
    ];
    const seen = new Set<string>();
    const add = (instruction: HostnameInstruction) => {
      const key = JSON.stringify(instruction);
      if (seen.has(key)) return;
      seen.add(key);
      instructions.push(instruction);
    };
    const ownership = record.ownership_verification;
    if (ownership && ownership.type === "txt") {
      add({ kind: "txt", name: ownership.name, value: ownership.value, purpose: "ownership" });
    }
    const records = record.ssl?.validation_records ?? [];
    for (const r of records) {
      if (r.txt_name && r.txt_value) {
        add({ kind: "txt", name: r.txt_name, value: r.txt_value, purpose: "certificate" });
      }
    }
    const ownershipHttp = record.ownership_verification_http;
    if (ownershipHttp) {
      add({
        kind: "http",
        url: ownershipHttp.http_url,
        body: ownershipHttp.http_body,
        purpose: "ownership",
      });
    }
    for (const r of records) {
      if (r.http_url && r.http_body) {
        add({ kind: "http", url: r.http_url, body: r.http_body, purpose: "certificate" });
      }
    }
    // Cloudflare reports errors as English sentences. TideGrid keeps codes only.
    const errors: string[] = [];
    if ((record.verification_errors ?? []).length > 0) errors.push("hostname_verification_error");
    if ((record.ssl?.validation_errors ?? []).length > 0) {
      errors.push("certificate_validation_error");
    }
    const certificateStatus = record.ssl?.status ?? "";
    return {
      providerId: record.id,
      hostname: record.hostname,
      hostnameState: mapCloudflareHostnameStatus(record.status),
      certificateState: mapCloudflareCertificateStatus(certificateStatus),
      raw: { hostnameStatus: record.status, certificateStatus },
      instructions,
      errors,
      checkedAt: this.#clock(),
    };
  }

  async #request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { search?: URLSearchParams; body?: unknown } = {},
  ): Promise<Answer> {
    const query = options.search ? `?${options.search.toString()}` : "";
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#base}${path}${query}`, init);
      text = await response.text();
    } catch {
      // A dropped connection or a deadline: the outcome is unknown. The cause
      // is not kept, so nothing from the request can travel with the error.
      throw new HostnameProviderUnavailableError(null);
    }
    const status = response.status;
    if (status === 429 || status >= 500) {
      throw new HostnameProviderUnavailableError(status, retryAfterSeconds(response.headers));
    }
    const envelope = parseEnvelope(text);
    if (status >= 400) {
      const code = firstErrorCode(envelope);
      if (status === 404 || code === notFoundCode) return { kind: "not_found" };
      if (status === 409 || code === duplicateCode) {
        throw new HostnameProviderRejectedError("already_exists");
      }
      throw new HostnameProviderRejectedError(
        code === null ? `http_${status}` : `cloudflare_${code}`,
      );
    }
    if (status < 200 || status >= 300 || !envelope || !envelope.success) throw malformed();
    return { kind: "ok", result: envelope.result };
  }
}

export function createCloudflareHostnameProvider(
  options: CloudflareHostnameOptions,
): CustomHostnameProvider {
  return new CloudflareHostnameProvider(options);
}
