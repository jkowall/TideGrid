import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  collectCspViolations,
  hostUrl,
  installability,
  localHost,
  serviceWorkerState,
  tenantManifests,
} from "../helpers.ts";

/**
 * Part B of the two-brand journey (G2.14b): the guest Worker bound to the
 * API's GuestGateway, the API on :8961 against a disposable PostgreSQL 17
 * seeded with SEED_LOCAL_HOSTNAMES=1. CI runs it; see .github/workflows/ci.yml.
 * E2E_DISABLE_HOST names an extra active hostname of the second tenant that
 * the last test disables through the admin CLI.
 */

const tenants = tenantManifests();
const API = "localhost:8961";

async function waitForReady(page: Page, name: string) {
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 20_000 });
}

async function controlled(page: Page) {
  return page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return true;
  });
}

async function cacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return urls;
  });
}

for (const tenant of tenants) {
  test(`${tenant.slug}: its own brand on every page, an installable app, and a service worker`, async ({
    page,
  }) => {
    const violations = collectCspViolations(page);
    const host = localHost(tenant.slug);
    await page.goto(hostUrl(host));
    await waitForReady(page, tenant.name);
    expect(await controlled(page)).toBe(true);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      tenant.primary,
    );

    for (const [path, heading] of [
      ["/support", "Help and support"],
      ["/offline", "Using this site offline"],
      ["/terms", "Terms of booking"],
      ["/privacy", "Privacy notice"],
      ["/legal/terms", "Terms of booking"],
    ] as const) {
      await page.goto(hostUrl(host, path));
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({
        timeout: 20_000,
      });
      if (path === "/offline") await expect(page.locator("body")).not.toContainText(tenant.name);
      else await expect(page.locator("footer")).toContainText(tenant.name);
      for (const other of tenants.filter((t) => t.slug !== tenant.slug)) {
        await expect(page.locator("body")).not.toContainText(other.name);
      }
    }

    const { manifest, installabilityErrors } = await installability(page);
    expect(manifest.errors).toEqual([]);
    expect(JSON.parse(manifest.data ?? "{}")).toMatchObject({
      name: tenant.name,
      theme_color: tenant.primary,
    });
    // Recorded in the CI log as installability evidence.
    console.log(
      `installability ${tenant.slug}: ${JSON.stringify({ manifestErrors: manifest.errors, installabilityErrors })}`,
    );
    test.info().annotations.push({
      type: "installability",
      description: JSON.stringify(installabilityErrors),
    });
    if (installabilityErrors) {
      expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);
    }
    expect(violations).toEqual([]);
  });

  test(`${tenant.slug}: manage and waiver links leave no token or API answer in CacheStorage`, async ({
    page,
  }) => {
    const host = localHost(tenant.slug);
    await page.goto(hostUrl(host));
    await waitForReady(page, tenant.name);
    await controlled(page);
    await page.reload();
    await waitForReady(page, tenant.name);
    // Link-shaped addresses run the real redemption against the API, which
    // refuses these synthetic tokens; the cache rules hold either way.
    await page.goto(hostUrl(host, "/manage#t=e2e-manage-token-0123456789abcdef"));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    await page.goto(hostUrl(host, "/waiver#t=e2e-waiver-token-0123456789abcdef"));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    const keys = await cacheKeys(page);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/#|t=|\/manage|\/waiver|\/book\//);
      expect(key).not.toContain(API);
      expect(key).not.toContain("api.tidegrid.us");
    }
  });
}

test("a new service worker waits through the visit and takes over on the next navigation (D11(a))", async ({
  page,
}) => {
  // Edits the served dist/sw.js, so it runs once, at one width.
  test.skip(test.info().project.name !== "desktop", "runs once");
  const tenant = tenants[0];
  if (!tenant) return;
  const host = localHost(tenant.slug);
  const file = new URL("../../dist/sw.js", import.meta.url);
  const original = readFileSync(file, "utf8");
  const registration = () =>
    page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration("/");
      return {
        active: r?.active?.state ?? null,
        waiting: r?.waiting?.state ?? null,
        installing: r?.installing?.state ?? null,
      };
    });
  try {
    await page.goto(hostUrl(host));
    await waitForReady(page, tenant.name);
    expect(await controlled(page)).toBe(true);
    // Build N+1 ships a changed worker.
    writeFileSync(file, `${original}\n// e2e update ${Date.now()}\n`);
    // The browser's update check on this navigation installs it. It waits
    // unless this load already found it waiting; the worker never skips
    // waiting by itself (unit tests hold that).
    await page.reload();
    await waitForReady(page, tenant.name);
    await expect
      .poll(
        async () => {
          const r = await registration();
          return r.waiting === "installed" || (r.active === "activated" && !r.installing);
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    // The next navigation's page load asks a waiting worker to take over.
    await page.goto(hostUrl(host));
    await waitForReady(page, tenant.name);
    await expect
      .poll(registration, { timeout: 20_000 })
      .toEqual({ active: "activated", waiting: null, installing: null });
  } finally {
    writeFileSync(file, original);
  }
});

test("an unknown host shows the not-published screen and installs nothing", async ({ page }) => {
  const host = "nobody.book.localhost";
  await page.goto(hostUrl(host));
  await expect(
    page.getByRole("heading", { level: 1, name: "There's no booking site at this address" }),
  ).toBeVisible({ timeout: 20_000 });
  const manifest = await page.request.get(hostUrl(host, "/manifest.webmanifest"));
  expect(manifest.status()).toBe(404);
  await expect
    .poll(async () => serviceWorkerState(page), { timeout: 10_000 })
    .toEqual({ registrations: 0, caches: [] });
});

test("a disabled host fails closed after a hard reload and its service worker unregisters", async ({
  page,
}) => {
  const host = process.env.E2E_DISABLE_HOST;
  const admin = process.env.E2E_ADMIN_DATABASE_URL;
  test.skip(!host || !admin, "needs E2E_DISABLE_HOST and E2E_ADMIN_DATABASE_URL");
  // A disabled name never comes back, so this runs once, at one width.
  test.skip(test.info().project.name !== "desktop", "runs once");
  if (!host || !admin) return;
  const slug = tenants[1]?.slug ?? "demo-reef";
  const name = tenants[1]?.name ?? "Demo Reef Divers";
  await page.goto(hostUrl(host));
  await waitForReady(page, name);
  expect(await controlled(page)).toBe(true);
  expect((await serviceWorkerState(page)).registrations).toBe(1);

  execFileSync(
    "pnpm",
    ["--filter", "@tidegrid/hostnames-cli", "hostnames", "disable", slug, host, "G2.14b e2e"],
    { env: { ...process.env, DATABASE_URL: admin }, stdio: "pipe", cwd: "../.." },
  );

  // A hard reload: no HTTP cache, so the bootstrap's 60 second max-age does not apply.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "There's no booking site at this address" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => serviceWorkerState(page), { timeout: 15_000 })
    .toEqual({ registrations: 0, caches: [] });
  const sw = await page.request.get(hostUrl(host, "/sw.js"));
  expect(sw.headers()["clear-site-data"]).toBe('"cache"');
});
