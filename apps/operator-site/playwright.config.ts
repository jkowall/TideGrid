import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { deployedBaseUrl, privateDir, privateFile } from "@tidegrid/release/deployed-gate";

/**
 * Browser checks for the operator console (G2.12d), against the built dist/
 * under `wrangler dev --env dev` on port 5382, so the console Worker forwards
 * /api to the API's ConsoleGateway and public/_headers sets the CSP.
 *
 * The API runs beside it on :8981 (`wrangler dev --env dev`, the dev registry
 * name tidegrid-api-dev) against a disposable PostgreSQL 17 seeded with the
 * synthetic operators, STAFF_ORIGINS set to http://localhost:5382. CI starts
 * the API; this config starts the console.
 *
 *   E2E_CHANNEL  the browser channel. Outside CI it defaults to "chrome", an
 *                installed Google Chrome, so a local run never needs a
 *                browser download; never run `playwright install` on the
 *                owner's machine. CI uses the Chromium its job installs.
 *
 * Port 5382 must be free: the suite starts its own server and fails at once
 * when something else holds it, rather than testing the wrong server.
 *
 * Build first: `pnpm --filter @tidegrid/operator-site build`.
 *
 * Deployed mode (Nov 1 runbook, P6 steps 5 and 7) is on exactly when
 * E2E_BASE_URL is set, for example https://console.tidegrid.us. It starts no
 * server, keeps no trace, screenshot, or video unless a spec takes one, and
 * writes its output only to $NOV1_PRIVATE_DIR/traces. E2E_STORAGE_STATE is
 * the signed-in Access session, a 0600 file in $NOV1_PRIVATE_DIR. Both are
 * checked here, at config load, so a missing or loose one refuses before
 * anything runs. The globalSetup refuses a run outside `nov1 accept`
 * (tools/release/src/deployed-gate.ts); `--list` runs no globalSetup, so
 * listing needs no go. The specs read the rest (e2e/helpers.ts).
 */
const channel = process.env.CI ? process.env.E2E_CHANNEL : (process.env.E2E_CHANNEL ?? "chrome");
const deployed = process.env.E2E_BASE_URL !== undefined;

const projects: NonNullable<PlaywrightTestConfig["projects"]> = [
  { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } } },
  { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
];

function localConfig(): PlaywrightTestConfig {
  return {
    testDir: "./e2e",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: Boolean(process.env.CI),
    timeout: 120_000,
    reporter: process.env.CI ? [["list"], ["github"]] : "list",
    use: {
      baseURL: "http://localhost:5382",
      trace: "retain-on-failure",
      acceptDownloads: true,
      ...(channel ? { channel } : {}),
    },
    projects,
    webServer: {
      command: "pnpm dev:worker",
      url: "http://localhost:5382/favicon.svg",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
    },
  };
}

function deployedConfig(): PlaywrightTestConfig {
  const base = deployedBaseUrl(process.env.E2E_BASE_URL);
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const dir = privateDir({ env: process.env, repoRoot });
  const storageState = privateFile(process.env.E2E_STORAGE_STATE, dir, "E2E_STORAGE_STATE");
  return {
    testDir: "./e2e",
    outputDir: join(dir, "traces"),
    globalSetup: "./e2e/helpers.ts",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    timeout: 120_000,
    reporter: "list",
    use: {
      baseURL: base.origin,
      storageState,
      trace: "off",
      screenshot: "off",
      video: "off",
      acceptDownloads: true,
      ...(channel ? { channel } : {}),
    },
    projects,
  };
}

export default defineConfig(deployed ? deployedConfig() : localConfig());
