import { readdirSync, readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { assertDeployedRunAllowed, DeployedGateRefusal } from "@tidegrid/release/deployed-gate";

/**
 * Shared by the console specs. Deployed mode (Nov 1 runbook, P6 steps 5 and
 * 7) is on exactly when E2E_BASE_URL is set; playwright.config.ts checks the
 * URL, the private directory, and E2E_STORAGE_STATE, which is already signed
 * in, so no spec signs in there. The default export is the deployed
 * globalSetup: it refuses unless the run comes from `nov1 accept` on the
 * owner's terminal.
 */
export const deployed = process.env.E2E_BASE_URL !== undefined;

/** A variable deployed mode needs; refuses clearly, at collection, when it is missing. */
export function deployedEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new DeployedGateRefusal(
      `Deployed browser run refused: ${name} is required in deployed mode`,
    );
  }
  return value;
}

/** The synthetic tenants in config/tenants, which name each operator's slug and name. */
export function tenantManifests(): { slug: string; names: string[] }[] {
  const dir = new URL("../../../config/tenants/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const m = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
      return { slug: m.slug, names: [...new Set<string>([m.displayName, m.brand.name])] };
    });
}

/** CSP violations the page reports, collected from the console. */
export function cspViolations(page: Page): string[] {
  const found: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) found.push(text);
  });
  return found;
}

/** Local only: sign in with the local sign-in link. */
export async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByRole("link", { name: "Open the local sign-in link" }).click();
  // The link opens a confirmation, so a mail scanner's visit signs no one in.
  await page.getByRole("button", { name: "Continue signing in" }).click();
  await consoleReady(page);
}

/** The console has loaded for a signed-in person. */
export async function consoleReady(page: Page) {
  await expect(page.getByRole("navigation", { name: "Console" })).toBeAttached({
    timeout: 30_000,
  });
}

/** Deployed: the storage state is signed in already, so open the console and wait for it. */
export async function openSignedIn(page: Page) {
  await page.goto("/");
  await consoleReady(page);
}

/** globalSetup: refuses the run, before any browser starts, unless the gate passes. */
export default function deployedGlobalSetup(): void {
  const go = assertDeployedRunAllowed({
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
  });
  console.log(`deployed console run allowed under gate ${go}`);
}
