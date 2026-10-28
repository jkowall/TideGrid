/**
 * The provider-neutral custom-hostname adapter (G2.14b). Hostname lifecycle
 * code talks to a provider only through this interface. The demo runs the
 * scripted fake in `fake.ts`; `cloudflare.ts` is the Cloudflare for SaaS
 * client, tested only against recorded fixtures until the owner enables SaaS.
 * No method may be called inside a database transaction.
 */

export type HostnameProviderName = "fake" | "cloudflare_saas";

/** The provider's hostname (ownership) state, mapped exhaustively. See `status.ts`. */
export type HostnameState = "pending" | "active" | "moved" | "blocked" | "deleted" | "unknown";

/**
 * The provider's certificate state, mapped exhaustively. `expiring` is a valid
 * certificate close to expiry: still servable, and flagged for monitoring
 * (G2.14b, D10).
 */
export type CertificateState = "pending" | "active" | "expiring" | "failed" | "unknown";

/** What a guest or operator must publish in DNS. Public values only, never secrets. */
export type HostnameInstruction =
  | { kind: "cname"; name: string; target: string }
  | { kind: "txt"; name: string; value: string; purpose: "ownership" | "certificate" }
  | { kind: "http"; url: string; body: string; purpose: "ownership" | "certificate" };

export interface ProviderHostname {
  providerId: string;
  /** The hostname the provider holds, normalized. */
  hostname: string;
  hostnameState: HostnameState;
  certificateState: CertificateState;
  /** The provider's own status strings, for logs and support. */
  raw: { hostnameStatus: string; certificateStatus: string };
  instructions: HostnameInstruction[];
  /** Provider error codes, lowercase snake case. */
  errors: string[];
  checkedAt: Date;
}

export type CertificateValidation = "txt" | "http";

export interface CustomHostnameProvider {
  name: HostnameProviderName;
  /** The CNAME target an operator points the hostname at. */
  routingTarget(): string;
  /**
   * Create the provider's record for a hostname. Throws
   * `HostnameProviderRejectedError` with `already_exists` when the provider
   * holds the name already, and `HostnameProviderUnavailableError` when the
   * outcome is unknown or temporary.
   */
  create(input: {
    hostname: string;
    certificateValidation?: CertificateValidation;
  }): Promise<ProviderHostname>;
  /**
   * Read one record. Returns null when the provider has none. Throws
   * `HostnameProviderRejectedError` (`hostname_mismatch`) when the record
   * names another hostname than `expectedHostname`.
   */
  get(providerId: string, expectedHostname: string): Promise<ProviderHostname | null>;
  /**
   * Exact-match lookup by name, never a substring or prefix search. Returns
   * null when the provider holds no record for exactly this hostname.
   */
  findByHostname(hostname: string): Promise<ProviderHostname | null>;
  /** Ask the provider to check validation again now. */
  refreshValidation(providerId: string, expectedHostname: string): Promise<ProviderHostname>;
  /** Remove a record. Removing one that is already gone succeeds. */
  remove(providerId: string): Promise<void>;
}

/**
 * Whether a hostname may serve guests: the provider reports its ownership
 * active and a valid certificate. A certificate in `expiring` is still valid
 * (G2.14b, D10). Activation is stricter and wants both `active`.
 */
export function isServable(h: Pick<ProviderHostname, "hostnameState" | "certificateState">) {
  return (
    h.hostnameState === "active" &&
    (h.certificateState === "active" || h.certificateState === "expiring")
  );
}

/** Whether a reading is enough to activate a pending hostname: both states active. */
export function isActivatable(h: Pick<ProviderHostname, "hostnameState" | "certificateState">) {
  return h.hostnameState === "active" && h.certificateState === "active";
}

const codePattern = /^[a-z][a-z0-9_]{0,63}$/;

/** The provider did not answer, or asked to wait (429 or 5xx). Retry later. */
export class HostnameProviderUnavailableError extends Error {
  constructor(
    readonly status: number | null,
    readonly retryAfterSeconds: number | null = null,
    message = "the custom-hostname provider is unavailable",
  ) {
    super(message);
    this.name = "HostnameProviderUnavailableError";
  }
}

/** The provider refused the request, or answered something TideGrid cannot trust. */
export class HostnameProviderRejectedError extends Error {
  constructor(
    readonly code: string,
    message = `the custom-hostname provider refused the request: ${code}`,
    /** The HTTP status of the refusal, when it came from an HTTP answer. */
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "HostnameProviderRejectedError";
    if (!codePattern.test(code))
      throw new TypeError("a provider error code is lowercase snake case");
  }
}
