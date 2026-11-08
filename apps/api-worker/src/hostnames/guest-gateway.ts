import type { PublicExperienceResponse } from "@tidegrid/contracts";
import { createDb } from "@tidegrid/database";
import { parseHostname } from "@tidegrid/domain-hostnames";
import { createLogger, newRequestId } from "@tidegrid/observability";
import { type Bindings, databaseUrl } from "../env.ts";
import { hostPolicy, loadPublicExperience, type PublicExperience } from "../public-tenant.ts";
import { TtlProjection } from "./projection.ts";

/**
 * What the guest Worker learns about the host a request reached (G2.14b):
 *
 * - `found`: the public experience, exactly what `/v1/public/tenant` would
 *   serve that host, public brand fields only. `brand` is absent while the
 *   operator has not published one.
 * - `miss`: a definite miss. The database says no active, verified hostname
 *   of an active tenant matches, or the host does not pass the strict rules,
 *   so no database could match it. The guest Worker may serve its kill
 *   switch only for this answer.
 * - `withheld`: the stored brand failed validation. Not a miss: the guest
 *   Worker answers 503 and clears nothing.
 * - `limited`: the gateway did not look. The host is not known to this
 *   isolate and its miss budget is spent (G2.14b-live, below). Not a miss:
 *   the guest Worker answers 503 and clears nothing. A guest Worker built
 *   before this answer existed reads any other kind as 503 too.
 *
 * A database failure throws, which the guest Worker also answers with 503.
 */
export type GuestHostAnswer =
  | { kind: "found"; experience: PublicExperienceResponse }
  | { kind: "miss" }
  | { kind: "withheld" }
  | { kind: "limited" };

/**
 * The guest host projection: `found` answers only, kept in this isolate's
 * memory for at most 10 seconds and at most 1,000 hosts, least recently used
 * out first (coordinator defaults confirmed by the owner on 2026-11-08, in the
 * decision register). One page load asks the gateway up to four times (the manifest,
 * two icons, and `/sw.js`), and before this each call opened and closed its
 * own database connection (the demo build plan's pre-release note on
 * G2.14b-live). Once a `found` answer is kept, later calls to the same
 * isolate within 10 seconds open none. Calls that arrive before it is kept,
 * or reach another isolate, still read the database: reads in flight are not
 * shared, because a promise settled by another request's I/O is unsupported
 * in Workers.
 *
 * - A `miss`, a `withheld` brand, and a database failure are never kept, so
 *   the kill switch and the 503 always come from a fresh read.
 * - The cost: a host disabled, or a brand republished, can keep its old
 *   `found` answer in one isolate for up to 10 seconds. The guest Worker then
 *   serves the old manifest, icons, and service worker for that long, and
 *   the kill switch follows within the same bound.
 * - The key is the environment and the host as parsed under that
 *   environment's policy, so a host refused in one environment never reaches
 *   the projection there.
 * - Data routes never read it; tenant selection for data is resolved on each
 *   request, as before.
 * - Callers get a copy, so a direct caller can never change a kept answer.
 */
export const GUEST_HOST_TTL_MS = 10_000;
export const GUEST_HOST_MAX_ENTRIES = 1_000;
export const guestHostProjection = new TtlProjection<PublicExperienceResponse>(
  GUEST_HOST_MAX_ENTRIES,
  GUEST_HOST_TTL_MS,
);

/**
 * The miss budget (G2.14b-live; coordinator defaults D1 to D3, pending owner
 * confirmation). Under Cloudflare for SaaS a fallback origin can send any
 * hostname, and nothing is kept for a miss, so without a limit every
 * arbitrary host would open a database connection.
 *
 * - D1: a token bucket per isolate, in memory, with no Workers rate-limit
 *   binding. A lookup for a host this isolate does not know takes a token
 *   before it opens a connection. A `found` answer gives the token back at
 *   once. A `miss`, a `withheld` brand, and a failure keep it until 10
 *   seconds after the lookup began.
 * - D2: no negative cache. A host activated a moment ago resolves on its
 *   next lookup that gets a token.
 * - D3: 20 tokens per 10 seconds per isolate, revisited at P10. Each token
 *   comes back 10 seconds after the lookup that spent it began, so no
 *   10-second span opens more than 20 lookups for unknown hosts that end as
 *   a miss, a withheld brand, or a failure, and no more than 20 such
 *   lookups run at once.
 *
 * With no token, the answer is `limited`: a 503 from the guest Worker,
 * never the kill switch. Only a lookup that reached the database and found
 * nothing, or a host the strict rules refuse, is a miss.
 */
export const GUEST_MISS_BUDGET = 20;
export const GUEST_MISS_WINDOW_MS = 10_000;

export class LookupBudget {
  /** Start times of settled lookups whose token has not come back yet. */
  #spent: number[] = [];
  /** Lookups under way: each holds a token until it settles. */
  #open = 0;

  constructor(
    readonly capacity: number,
    readonly windowMs: number,
  ) {}

  /** Takes a token for a lookup starting at `now`, or answers false. */
  take(now: number): boolean {
    this.#spent = this.#spent.filter((started) => started + this.windowMs > now);
    if (this.#spent.length + this.#open >= this.capacity) return false;
    this.#open += 1;
    return true;
  }

  /**
   * Ends a lookup that took a token at `startedAt`. A spent token comes back
   * `windowMs` after the lookup began; a token not spent comes back now.
   */
  settle(startedAt: number, spent: boolean): void {
    this.#open = Math.max(0, this.#open - 1);
    if (spent) this.#spent.push(startedAt);
  }

  /** Tokens free at `now`. */
  available(now: number): number {
    const held = this.#spent.filter((started) => started + this.windowMs > now).length;
    return Math.max(0, this.capacity - held - this.#open);
  }

  clear(): void {
    this.#spent = [];
    this.#open = 0;
  }
}

export const guestMissBudget = new LookupBudget(GUEST_MISS_BUDGET, GUEST_MISS_WINDOW_MS);

/**
 * Hosts this isolate has recently found (D4, a coordinator default pending
 * owner confirmation): a host whose last lookup here answered `found`, in
 * the last 10 minutes, at most 1,000 hosts, least recently used out first.
 * Such a host skips the miss budget, so a flood of unknown hosts cannot turn
 * a live operator's page into a 503 when its kept answer expires. It is not
 * a cache: the host is still read afresh each time it is not kept as
 * `found` above, so a disable still serves the kill switch once that kept
 * answer expires. A `miss`, a `withheld` answer, or a failure removes the
 * host, and its next lookup takes a token like any unknown host, so a
 * database outage cannot make a known host's reads unbounded. Only a
 * database `found` answer adds one.
 */
export const GUEST_KNOWN_TTL_MS = 600_000;
export const GUEST_KNOWN_MAX_ENTRIES = 1_000;
export const guestKnownHosts = new TtlProjection<true>(GUEST_KNOWN_MAX_ENTRIES, GUEST_KNOWN_TTL_MS);

/** Refused lookups since the last `guest_host_lookup_limited` log, at most one log per window. */
let limitedSinceLog = 0;
let limitedLoggedAt = Number.NEGATIVE_INFINITY;

function logLimited(env: Bindings, now: number): void {
  limitedSinceLog += 1;
  if (now - limitedLoggedAt < GUEST_MISS_WINDOW_MS) return;
  createLogger({
    "tidegrid.request_id": newRequestId(),
    "tidegrid.environment": env.ENVIRONMENT,
  }).warn(`guest_host_lookup_limited refused ${limitedSinceLog}`, {
    "event.name": "guest_host_lookup_limited",
  });
  limitedSinceLog = 0;
  limitedLoggedAt = now;
}

/** One database read of the public experience, on its own one-connection handle. */
export type GuestHostLookup = (env: Bindings, host: string) => Promise<PublicExperience>;

const lookupPublicExperience: GuestHostLookup = async (env, host) => {
  const url = databaseUrl(env);
  if (!url) throw new Error("database_unconfigured");
  const handle = createDb(url, { max: 1 });
  try {
    return await loadPublicExperience(handle.db, host);
  } finally {
    await handle.end();
  }
};

/**
 * GuestGateway.resolveHost. It checks the host itself with the same rules as
 * an Origin (lowercase ASCII, no trailing dot, no punycode, no IP literal,
 * and outside local development no loopback-only name), because it never
 * trusts its caller's parsing. A `found` answer may come from the guest host
 * projection above. Otherwise a host this isolate has recently found reads
 * the database at once, and any other host first takes a token from the miss
 * budget, or answers `limited`. Each read opens its own connection and
 * closes it. `lookup` is replaceable only so unit tests can count reads.
 */
export async function resolveGuestHost(
  env: Bindings,
  host: unknown,
  lookup: GuestHostLookup = lookupPublicExperience,
): Promise<GuestHostAnswer> {
  const parsed = parseHostname(host, hostPolicy(env));
  if (!parsed) return { kind: "miss" };
  const key = `${env.ENVIRONMENT ?? ""}|${parsed}`;
  const now = Date.now();
  const cached = guestHostProjection.get(key, now);
  if (cached) return { kind: "found", experience: structuredClone(cached) };
  if (!databaseUrl(env)) throw new Error("database_unconfigured");
  const known = guestKnownHosts.get(key, now) !== undefined;
  if (!known && !guestMissBudget.take(now)) {
    logLimited(env, now);
    return { kind: "limited" };
  }
  let found: PublicExperience;
  try {
    found = await lookup(env, parsed);
  } catch (error) {
    if (known) guestKnownHosts.delete(key);
    else guestMissBudget.settle(now, true);
    throw error;
  }
  if (!known) guestMissBudget.settle(now, found.kind !== "found");
  if (found.kind === "miss") {
    guestKnownHosts.delete(key);
    return { kind: "miss" };
  }
  if (found.kind === "withheld") {
    guestKnownHosts.delete(key);
    createLogger({
      "tidegrid.request_id": newRequestId(),
      "tidegrid.environment": env.ENVIRONMENT,
    }).error(`public_experience_withheld version ${found.version ?? "none"}`, {
      "event.name": "public_experience_withheld",
      "tidegrid.tenant_id": found.tenantId,
      "error.type": found.reason,
    });
    return { kind: "withheld" };
  }
  guestHostProjection.set(key, structuredClone(found.experience), now);
  guestKnownHosts.set(key, true, now);
  return { kind: "found", experience: found.experience };
}
