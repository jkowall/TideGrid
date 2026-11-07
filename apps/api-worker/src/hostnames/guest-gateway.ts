import type { PublicExperienceResponse } from "@tidegrid/contracts";
import { createDb } from "@tidegrid/database";
import { parseHostname } from "@tidegrid/domain-hostnames";
import { createLogger, newRequestId } from "@tidegrid/observability";
import { type Bindings, databaseUrl } from "../env.ts";
import { hostPolicy, loadPublicExperience } from "../public-tenant.ts";
import { TtlProjection } from "./projection.ts";

/**
 * What the guest Worker learns about the host a request reached (G2.14b):
 *
 * - `found`: the public experience, exactly what `/v1/public/tenant` would
 *   serve that host, public brand fields only. `brand` is absent while the
 *   operator has not published one.
 * - `miss`: a definite miss. No active, verified hostname of an active tenant
 *   matches, or the host does not pass the strict rules. The guest Worker may
 *   serve its kill switch only for this answer.
 * - `withheld`: the stored brand failed validation. Not a miss: the guest
 *   Worker answers 503 and clears nothing.
 *
 * A database failure throws, which the guest Worker also answers with 503.
 */
export type GuestHostAnswer =
  | { kind: "found"; experience: PublicExperienceResponse }
  | { kind: "miss" }
  | { kind: "withheld" };

/**
 * The guest host projection: `found` answers only, kept in this isolate's
 * memory for at most 10 seconds and at most 1,000 hosts, least recently used
 * out first. One page load asks the gateway up to four times (the manifest,
 * two icons, and `/sw.js`), and before this each call opened and closed its
 * own database connection (the demo build plan's pre-release note on
 * G2.14b-live).
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
 */
export const GUEST_HOST_TTL_MS = 10_000;
export const GUEST_HOST_MAX_ENTRIES = 1_000;
export const guestHostProjection = new TtlProjection<PublicExperienceResponse>(
  GUEST_HOST_MAX_ENTRIES,
  GUEST_HOST_TTL_MS,
);

/**
 * GuestGateway.resolveHost. It checks the host itself with the same rules as
 * an Origin (lowercase ASCII, no trailing dot, no punycode, no IP literal,
 * and outside local development no loopback-only name), because it never
 * trusts its caller's parsing. A `found` answer may come from the guest host
 * projection above; otherwise it opens its own connection and closes it.
 */
export async function resolveGuestHost(env: Bindings, host: unknown): Promise<GuestHostAnswer> {
  const parsed = parseHostname(host, hostPolicy(env));
  if (!parsed) return { kind: "miss" };
  const key = `${env.ENVIRONMENT ?? ""}|${parsed}`;
  const now = Date.now();
  const cached = guestHostProjection.get(key, now);
  if (cached) return { kind: "found", experience: cached };
  const url = databaseUrl(env);
  if (!url) throw new Error("database_unconfigured");
  const handle = createDb(url, { max: 1 });
  try {
    const found = await loadPublicExperience(handle.db, parsed);
    if (found.kind === "miss") return { kind: "miss" };
    if (found.kind === "withheld") {
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
    guestHostProjection.set(key, found.experience, now);
    return { kind: "found", experience: found.experience };
  } finally {
    await handle.end();
  }
}
