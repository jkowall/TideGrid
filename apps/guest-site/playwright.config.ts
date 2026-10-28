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
 *   E2E_CHANNEL    "chrome" uses an installed Google Chrome instead of the
 *                  downloaded Chromium, for local runs.
 *
 * Build first: `VITE_API_BASE=http://localhost:8961 GUEST_LOCAL_API=http://localhost:8961 pnpm build`.
 */
const mode = process.env.E2E_MODE === "full" ? "full" : "stub";
const channel = process.env.E2E_CHANNEL;

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
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
  },
});
