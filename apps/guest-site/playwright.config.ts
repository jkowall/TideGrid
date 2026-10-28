import { defineConfig, devices } from "@playwright/test";

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
 */
const mode = process.env.E2E_MODE === "full" ? "full" : "stub";
const channel = process.env.CI ? process.env.E2E_CHANNEL : (process.env.E2E_CHANNEL ?? "chrome");

export default defineConfig({
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
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } } },
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: mode === "full" ? "pnpm dev:worker" : "pnpm dev:stub",
    url: "http://localhost:5361/favicon.svg",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
  },
});
