import type { PublicExperienceResponse } from "@tidegrid/contracts";
import { createDb } from "@tidegrid/database";
import { parseHostname } from "@tidegrid/domain-hostnames";
import { createLogger, newRequestId } from "@tidegrid/observability";
import { type Bindings, databaseUrl } from "../env.ts";
import { hostPolicy, loadPublicExperience } from "../public-tenant.ts";

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
 * GuestGateway.resolveHost. It checks the host itself with the same rules as
 * an Origin (lowercase ASCII, no trailing dot, no punycode, no IP literal,
 * and outside local development no loopback-only name), because it never
 * trusts its caller's parsing. It opens its own connection and closes it.
 */
export async function resolveGuestHost(env: Bindings, host: unknown): Promise<GuestHostAnswer> {
  const parsed = parseHostname(host, hostPolicy(env));
  if (!parsed) return { kind: "miss" };
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
    return { kind: "found", experience: found.experience };
  } finally {
    await handle.end();
  }
}
