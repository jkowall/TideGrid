import { WorkerEntrypoint } from "cloudflare:workers";
import { brandConfigFromManifest, parseTenantManifest } from "@tidegrid/tenant-config";
import harborLogo from "../../../config/tenants/demo-harbor/logo.svg";
import harborManifest from "../../../config/tenants/demo-harbor.json";
import reefLogo from "../../../config/tenants/demo-reef/logo.svg";
import reefManifest from "../../../config/tenants/demo-reef.json";

/**
 * A stand-in for the API's GuestGateway, for local and CI browser checks that
 * need no database (G2.14b, the two-brand journey's part A). Never deployed:
 * it has its own Wrangler config, worker/stub-gateway.wrangler.jsonc, with no
 * routes and no workers.dev URL.
 *
 * - demo-harbor.book.localhost and demo-reef.book.localhost: the two
 *   synthetic brands from config/tenants, as the seed publishes them.
 * - throws.book.localhost: the gateway fails, as an outage would.
 * - withheld.book.localhost: a brand that failed validation.
 * - anything else: a definite miss.
 */
function experience(manifest: unknown, logo: string) {
  const parsed = parseTenantManifest(manifest);
  const brand = brandConfigFromManifest(parsed, new TextEncoder().encode(logo));
  return {
    tenant: { slug: parsed.slug, name: parsed.displayName },
    brand: { ...brand, version: 1 },
  };
}

const found: Record<string, ReturnType<typeof experience>> = {
  "demo-harbor.book.localhost": experience(harborManifest, harborLogo),
  "demo-reef.book.localhost": experience(reefManifest, reefLogo),
};

export class GuestGateway extends WorkerEntrypoint {
  async resolveHost(host: unknown) {
    if (host === "throws.book.localhost") throw new Error("stub gateway outage");
    if (host === "withheld.book.localhost") return { kind: "withheld" };
    if (typeof host === "string" && Object.hasOwn(found, host)) {
      return { kind: "found", experience: found[host] };
    }
    return { kind: "miss" };
  }
}

export default {
  fetch: () => new Response("Not found.\n", { status: 404 }),
};
