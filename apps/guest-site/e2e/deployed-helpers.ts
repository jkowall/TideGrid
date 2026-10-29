import { randomBytes } from "node:crypto";
import {
  assertDeployedRunAllowed,
  DeployedGateRefusal,
  deployedBaseUrl,
} from "@tidegrid/release/deployed-gate";
import { tenantManifests } from "./helpers.ts";

/**
 * The guest site's deployed mode (Nov 1 runbook, P6 steps 1 and 2). It is on
 * exactly when E2E_BASE_URL is set, and E2E_BASE_URL says which hosts:
 *
 *   E2E_BASE_URL=https://{slug}.book.tidegrid.us
 *       a template: one host per tenant in config/tenants, with {slug}
 *       replaced by each slug. E2E_TENANT must be unset.
 *   E2E_BASE_URL=https://demo.tidegrid.us E2E_TENANT=demo-harbor
 *       one origin that serves one tenant, as on the cutover rerun of step 1.
 *
 * Every host must pass deployedBaseUrl: https, no port, no credentials, no
 * path, and not a local name. The default export is the globalSetup: it
 * refuses unless the run comes from `nov1 accept` on the owner's terminal.
 */

export interface DeployedHost {
  slug: string;
  name: string;
  primary: string;
  /** The host's origin, such as https://demo-reef.book.tidegrid.us. */
  origin: string;
}

const refuse = (why: string): never => {
  throw new DeployedGateRefusal(`Deployed browser run refused: ${why}`);
};

/** The hosts a deployed run visits, in config/tenants order. */
export function deployedHosts(
  env: Record<string, string | undefined> = process.env,
): DeployedHost[] {
  const raw = env.E2E_BASE_URL;
  deployedBaseUrl(raw);
  const template = raw as string;
  const tenants = tenantManifests();
  if (template.includes("{slug}")) {
    if (env.E2E_TENANT)
      refuse("E2E_TENANT is only for one origin; the template names every tenant");
    return tenants.map((t) => ({
      ...t,
      origin: deployedBaseUrl(template.replaceAll("{slug}", t.slug)).origin,
    }));
  }
  const slug = env.E2E_TENANT;
  if (!slug) refuse("E2E_TENANT is required when E2E_BASE_URL has no {slug}");
  const tenant = tenants.find((t) => t.slug === slug);
  if (!tenant) refuse("E2E_TENANT names no tenant in config/tenants");
  return [{ ...(tenant as (typeof tenants)[number]), origin: deployedBaseUrl(template).origin }];
}

/** True when E2E_BASE_URL is a {slug} template, so each tenant has its own preview host. */
export function perTenantHosts(env: Record<string, string | undefined> = process.env): boolean {
  return (env.E2E_BASE_URL ?? "").includes("{slug}");
}

export function hostPath(host: DeployedHost, path = "/"): string {
  return `${host.origin}${path}`;
}

/** A synthetic address at a reserved .test domain, unique to this run. */
export function syntheticEmail(label: string): string {
  return `nov1.${label}.${randomBytes(4).toString("hex")}@nov1-acceptance.test`;
}

/** A local date, YYYY-MM-DD, `days` after today in UTC. */
export function daysFromToday(days: number, now = Date.now()): string {
  return new Date(now + days * 86_400_000).toISOString().slice(0, 10);
}

/** globalSetup: refuses the run, before any browser starts, unless the gate passes. */
export default function deployedGlobalSetup(): void {
  const go = assertDeployedRunAllowed({
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
  });
  console.log(`deployed guest run allowed under gate ${go}`);
}
