import { defineConfig, devices } from "@playwright/test";

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
 */
const channel = process.env.CI ? process.env.E2E_CHANNEL : (process.env.E2E_CHANNEL ?? "chrome");

export default defineConfig({
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
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } } },
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: "pnpm dev:worker",
    url: "http://localhost:5382/favicon.svg",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
  },
});
