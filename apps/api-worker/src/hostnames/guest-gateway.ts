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
 *   once. A `miss`, a `withheld` brand, a failure, and a lookup that never
 *   ends (one cancelled mid-read, for example) keep it until 10 seconds after
 *   the lookup began, and no longer.
 * - D2: no negative cache. A host activated a moment ago resolves on its
 *   next lookup that gets a token.
 * - D3: 20 tokens per 10 seconds per isolate, revisited at P10. Each token
 *   comes back at most 10 seconds after the lookup that took it began, so no
 *   10-second span opens more than 20 lookups for unknown hosts that end as a
 *   miss, a withheld brand, or a failure, or that never end. A lookup that
 *   runs past 10 seconds no longer holds its token, so while reads hang, at
 *   most 20 more start every 10 seconds.
 *
 * With no token, the answer is `limited`: a 503 from the guest Worker,
 * never the kill switch. Only a lookup that reached the database and found
 * nothing, or a host the strict rules refuse, is a miss.
 */
export const GUEST_MISS_BUDGET = 20;
export const GUEST_MISS_WINDOW_MS = 10_000;

/** One token out: it comes back `windowMs` after `startedAt`, or when released. */
export interface LookupHold {
  readonly startedAt: number;
}

export class LookupBudget {
  /** Tokens out. Each expires `windowMs` after its lookup began. */
  readonly #held = new Set<LookupHold>();

  constructor(
    readonly capacity: number,
    readonly windowMs: number,
  ) {}

  /** Takes a token for a lookup starting at `now`, or answers undefined. */
  take(now: number): LookupHold | undefined {
    this.#expire(now);
    if (this.#held.size >= this.capacity) return undefined;
    const hold = { startedAt: now };
    this.#held.add(hold);
    return hold;
  }

  /** Gives a token back at once. A token never released comes back `windowMs` after it was taken. */
  release(hold: LookupHold): void {
    this.#held.delete(hold);
  }

  /** Tokens free at `now`. */
  available(now: number): number {
    this.#expire(now);
    return Math.max(0, this.capacity - this.#held.size);
  }

  clear(): void {
    this.#held.clear();
  }

  #expire(now: number): void {
    for (const hold of this.#held) {
      if (hold.startedAt + this.windowMs <= now) this.#held.delete(hold);
    }
  }
}

export const guestMissBudget = new LookupBudget(GUEST_MISS_BUDGET, GUEST_MISS_WINDOW_MS);

/**
 * Hosts this isolate has recently found (D4, a coordinator default pending
 * owner confirmation): a host whose last lookup here answered `found`, in
 * the last 10 minutes, at most 1,000 hosts, least recently used out first.
 * Such a host skips the miss budget, so in a warm isolate a flood of unknown
 * hosts cannot turn a live operator's page into a 503 when its kept answer
 * expires. A host this isolate has not found in 10 minutes, for example any
 * host in a fresh isolate after a deploy or on scale-out, goes through the
 * miss budget like any unknown host, and answers `limited` while a flood
 * holds every token (an open risk for P10, in the decision register). It is
 * not a cache: the host is still read afresh each time it is not kept as
 * `found` above, so a disable still serves the kill switch once that kept
 * answer expires. A `miss`, a `withheld` answer, or a failure removes the
 * host, and its next lookup takes a token like any unknown host. Only a
 * database `found` answer adds one.
 */
export const GUEST_KNOWN_TTL_MS = 600_000;
export const GUEST_KNOWN_MAX_ENTRIES = 1_000;
export const guestKnownHosts = new TtlProjection<true>(GUEST_KNOWN_MAX_ENTRIES, GUEST_KNOWN_TTL_MS);

/**
 * Reads of known hosts under way (D8, a coordinator default pending owner
 * confirmation): at most 20 per isolate at once. Each read holds a slot until
 * it settles, whatever its answer, and at most 10 seconds if it never
 * settles. Past the cap the answer is `limited`, never a miss. Reads in flight
 * are not shared between requests (see the projection above), so this cap is
 * what bounds a burst of calls for a live host when its kept answer expires,
 * or while the database is slow.
 */
export const GUEST_KNOWN_READS = 20;
export const guestKnownReads = new LookupBudget(GUEST_KNOWN_READS, GUEST_MISS_WINDOW_MS);

/**
 * Refused lookups, counted per 10-second window (D7). The first refusal of a
 * window logs `guest_host_lookup_limited started`, a leading-edge marker.
 * Once the window has closed, the isolate's next call logs
 * `guest_host_lookup_limited refused <n>`, the window's total. No hostname is
 * logged.
 */
export class RefusalTally {
  #windowStart = Number.NEGATIVE_INFINITY;
  #count = 0;

  constructor(readonly windowMs: number) {}

  /** The closed window's total, once, or undefined. */
  flush(now: number): number | undefined {
    if (this.#count === 0 || now - this.#windowStart < this.windowMs) return undefined;
    const total = this.#count;
    this.#count = 0;
    return total;
  }

  /** Counts one refusal; answers true when it opens a window. */
  refuse(now: number): boolean {
    this.#count += 1;
    if (this.#count > 1) return false;
    this.#windowStart = now;
    return true;
  }

  clear(): void {
    this.#windowStart = Number.NEGATIVE_INFINITY;
    this.#count = 0;
  }
}

export const guestLimitedTally = new RefusalTally(GUEST_MISS_WINDOW_MS);

function logLimited(env: Bindings, message: string): void {
  createLogger({
    "tidegrid.request_id": newRequestId(),
    "tidegrid.environment": env.ENVIRONMENT,
  }).warn(message, { "event.name": "guest_host_lookup_limited" });
}

function flushLimited(env: Bindings, now: number): void {
  const total = guestLimitedTally.flush(now);
  if (total !== undefined) logLimited(env, `guest_host_lookup_limited refused ${total}`);
}

function refuseLookup(env: Bindings, now: number): GuestHostAnswer {
  flushLimited(env, now);
  if (guestLimitedTally.refuse(now)) logLimited(env, "guest_host_lookup_limited started");
  return { kind: "limited" };
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
 * projection above. Otherwise a host this isolate has recently found takes
 * one of the known-host read slots, and any other host takes a token from
 * the miss budget; with neither, the answer is `limited`. Each read opens its
 * own connection and closes it. `lookup` is replaceable only so unit tests
 * can count reads.
 */
export async function resolveGuestHost(
  env: Bindings,
  host: unknown,
  lookup: GuestHostLookup = lookupPublicExperience,
): Promise<GuestHostAnswer> {
  const now = Date.now();
  flushLimited(env, now);
  const parsed = parseHostname(host, hostPolicy(env));
  if (!parsed) return { kind: "miss" };
  const key = `${env.ENVIRONMENT ?? ""}|${parsed}`;
  const cached = guestHostProjection.get(key, now);
  if (cached) return { kind: "found", experience: structuredClone(cached) };
  if (!databaseUrl(env)) throw new Error("database_unconfigured");
  const known = guestKnownHosts.get(key, now) !== undefined;
  const hold = known ? guestKnownReads.take(now) : guestMissBudget.take(now);
  if (!hold) return refuseLookup(env, now);
  let found: PublicExperience;
  try {
    found = await lookup(env, parsed);
  } catch (error) {
    // A failed read of an unknown host keeps its token for the window.
    if (known) {
      guestKnownReads.release(hold);
      guestKnownHosts.delete(key);
    }
    throw error;
  }
  if (known) guestKnownReads.release(hold);
  else if (found.kind === "found") guestMissBudget.release(hold);
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
