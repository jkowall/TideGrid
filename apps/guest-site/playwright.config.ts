import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { deployedBaseUrl, privateDir } from "@tidegrid/release/deployed-gate";
import { deployedHosts } from "./e2e/deployed-helpers.ts";

/**
 * Browser checks for the guest site (G2.14b), against the built dist/ under
 * `wrangler dev` on port 5361, with *.book.localhost hosts, which Chromium
 * resolves to this machine and treats as a secure context.
 *
 *   E2E_MODE=stub  Part A: the guest Worker with a stub GuestGateway and no
 *                  database (worker/stub-gateway.ts). Default.
 *   E2E_MODE=full  Part B: the guest Worker bound to the API's GuestGateway,
 *                  with the API on :8961 against a disposable PostgreSQL 17,
 *                  seeded with SEED_LOCAL_HOSTNAMES=1. CI starts the API;
 *                  E2E_ADMIN_DATABASE_URL lets the suite disable a host.
 *   E2E_CHANNEL    the browser channel. Outside CI it defaults to "chrome", an
 *                  installed Google Chrome, so a local run never needs a
 *                  browser download; never run `playwright install` on the
 *                  owner's machine. CI uses the Chromium its job installs.
 *
 * Port 5361 must be free: the suite starts its own server and fails at once,
 * naming the port, when something else (the Vite dev server, an old
 * `wrangler dev`) holds it, rather than testing the wrong server.
 *
 * Build first: `VITE_API_BASE=http://localhost:8961 GUEST_LOCAL_API=http://localhost:8961 pnpm build`.
 *
 * Deployed mode (Nov 1 runbook, P6 steps 1 and 2) is on exactly when
 * E2E_BASE_URL is set. It drives real hosts, so it starts no server, runs
 * ./e2e/deployed only, keeps no trace, screenshot, or video unless a spec
 * takes one, and writes its output only to $NOV1_PRIVATE_DIR/traces. The
 * private directory is checked here, at config load, so a missing or loose
 * one refuses before anything runs. The globalSetup refuses a run outside
 * `nov1 accept` (tools/release/src/deployed-gate.ts); `--list` runs no
 * globalSetup, so listing needs no go. See e2e/deployed-helpers.ts for
 * E2E_BASE_URL and E2E_TENANT.
 */
const channel = process.env.CI ? process.env.E2E_CHANNEL : (process.env.E2E_CHANNEL ?? "chrome");
const deployed = process.env.E2E_BASE_URL !== undefined;

const projects: NonNullable<PlaywrightTestConfig["projects"]> = [
  { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } } },
  { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
];

function localConfig(): PlaywrightTestConfig {
  const mode = process.env.E2E_MODE === "full" ? "full" : "stub";
  return {
    testDir: `./e2e/${mode}`,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: Boolean(process.env.CI),
    timeout: 60_000,
    reporter: process.env.CI ? [["list"], ["github"]] : "list",
    use: {
      trace: "retain-on-failure",
      ...(channel ? { channel } : {}),
    },
    projects,
    webServer: {
      command: mode === "full" ? "pnpm dev:worker" : "pnpm dev:stub",
      url: "http://localhost:5361/favicon.svg",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
    },
  };
}

function deployedConfig(): PlaywrightTestConfig {
  deployedBaseUrl(process.env.E2E_BASE_URL);
  deployedHosts();
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const dir = privateDir({ env: process.env, repoRoot });
  return {
    testDir: "./e2e/deployed",
    outputDir: join(dir, "traces"),
    globalSetup: "./e2e/deployed-helpers.ts",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    timeout: 60_000,
    reporter: "list",
    use: {
      trace: "off",
      screenshot: "off",
      video: "off",
      ...(channel ? { channel } : {}),
    },
    projects,
  };
}

export default defineConfig(deployed ? deployedConfig() : localConfig());
