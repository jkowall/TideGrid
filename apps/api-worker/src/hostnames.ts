import {
  type CustomHostnameProvider,
  createCloudflareHostnameProvider,
} from "@tidegrid/domain-hostnames";
import type { Bindings } from "./env.ts";

/**
 * Which custom-hostname provider this deployment's sweep reads (G2.14b).
 * Custom hostnames are off unless HOSTNAME_PROVIDER names one. The fake is
 * stricter than the payment and email fakes, which are refused only in a
 * production configuration: the deployed API runs ENVIRONMENT "preview", so
 * that rule would admit a hostname fake on api.tidegrid.us. This one is
 * accepted only in local development, and never beside a real SaaS zone.
 */
export type HostnameSettings =
  | { kind: "fake" }
  | { kind: "cloudflare_saas"; zoneId: string; apiToken: string; routingTarget: string }
  | { kind: "off"; reason: "unset" | "zone_missing" | "token_missing" }
  | { kind: "refused"; reason: "fake_outside_local" | "fake_with_zone" | "unknown_provider" };

export const DEFAULT_ROUTING_TARGET = "customers.tidegrid.us";

export function hostnameSettings(env: Bindings): HostnameSettings {
  const name = env.HOSTNAME_PROVIDER;
  if (!name) return { kind: "off", reason: "unset" };
  if (name === "fake") {
    if (env.CF_SAAS_ZONE_ID) return { kind: "refused", reason: "fake_with_zone" };
    if (env.ENVIRONMENT !== "local") return { kind: "refused", reason: "fake_outside_local" };
    return { kind: "fake" };
  }
  if (name === "cloudflare_saas") {
    if (!env.CF_SAAS_ZONE_ID) return { kind: "off", reason: "zone_missing" };
    if (!env.CF_SAAS_API_TOKEN) return { kind: "off", reason: "token_missing" };
    return {
      kind: "cloudflare_saas",
      zoneId: env.CF_SAAS_ZONE_ID,
      apiToken: env.CF_SAAS_API_TOKEN,
      routingTarget: env.CF_SAAS_ROUTING_TARGET || DEFAULT_ROUTING_TARGET,
    };
  }
  return { kind: "refused", reason: "unknown_provider" };
}

/**
 * The provider the cron's sweep reads, or null when it must not run. The
 * fake keeps its records in memory, so a fake built inside a Worker knows no
 * hostname, and every reading would come back "deleted" and demote every
 * fake row. Configured as the fake, the sweep therefore reads only a fake a
 * test or the admin CLI hands it, in the same process that holds its records.
 */
export function hostnameProvider(
  env: Bindings,
  injected?: CustomHostnameProvider,
): CustomHostnameProvider | null {
  const settings = hostnameSettings(env);
  switch (settings.kind) {
    case "fake":
      return injected?.name === "fake" ? injected : null;
    case "cloudflare_saas":
      return createCloudflareHostnameProvider({
        zoneId: settings.zoneId,
        apiToken: settings.apiToken,
        routingTarget: settings.routingTarget,
      });
    default:
      return null;
  }
}
