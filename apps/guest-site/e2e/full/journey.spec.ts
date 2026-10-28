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

const swFile = new URL("../../dist/sw.js", import.meta.url);

/** Build N+1: the built worker with a new build id, so its cache name changes. */
function shipNewWorker(original: string, buildId: string): void {
  const next = original.replace(/buildId:`[^`]+`/, `buildId:\`${buildId}\``);
  if (next === original) throw new Error("dist/sw.js has no build id to change");
  writeFileSync(swFile, next);
}

async function workerState(page: Page) {
  return page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration("/");
    return {
      active: r?.active?.state ?? null,
      waiting: r?.waiting?.state ?? null,
      installing: r?.installing?.state ?? null,
      caches: (await caches.keys()).sort(),
    };
  });
}

/**
 * Load the page until its worker controls it. A first visit registers the
 * worker but is not controlled (no clients.claim), and a worker with no
 * controlled window never waits. Reloads, not new navigations: a reload never
 * leaves the previous document in the back/forward cache, where it could
 * count as another open window.
 */
async function loadControlled(page: Page, url: string, name: string) {
  await page.goto(url);
  await waitForReady(page, name);
  await controlled(page);
  await page.reload();
  await waitForReady(page, name);
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

/** The browser's own update check, made now rather than at some later navigation. */
async function checkForUpdate(page: Page) {
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration("/"))?.update();
  });
}

test("a new service worker installs, waits, and takes over on the next navigation (D11(a))", async ({
  page,
  context,
}) => {
  // Edits the served dist/sw.js, so it runs once, at one width.
  test.skip(test.info().project.name !== "desktop", "runs once");
  test.setTimeout(240_000);
  const tenant = tenants[0];
  if (!tenant) return;
  const host = localHost(tenant.slug);
  const original = readFileSync(swFile, "utf8");
  try {
    await loadControlled(page, hostUrl(host), tenant.name);
    // Exactly one window, the one that will ask.
    expect(context.pages()).toHaveLength(1);
    const before = await workerState(page);
    expect(before.caches).toHaveLength(1);
    const oldCache = before.caches[0] ?? "";

    shipNewWorker(original, "e2e-single");
    await checkForUpdate(page);
    // A new worker really installed: it waits, and build N's cache is still there.
    await expect
      .poll(async () => (await workerState(page)).waiting, { timeout: 20_000 })
      .toBe("installed");
    expect((await workerState(page)).caches).toContain(oldCache);

    // The next navigation's page load asks it to take over; this is the one
    // window. The worker looks for up to 60 seconds for the documents earlier
    // reloads replaced to leave the browser's client list.
    await page.reload();
    await waitForReady(page, tenant.name);
    expect(context.pages()).toHaveLength(1);
    await expect
      .poll(async () => workerState(page), { timeout: 75_000 })
      .toEqual({
        active: "activated",
        waiting: null,
        installing: null,
        caches: ["tidegrid-guest-e2e-single"],
      });
  } finally {
    writeFileSync(swFile, original);
  }
});

test("a waiting service worker does not take over while another window is open (D11(a))", async ({
  page,
  context,
}) => {
  test.skip(test.info().project.name !== "desktop", "runs once");
  test.setTimeout(240_000);
  const tenant = tenants[0];
  if (!tenant) return;
  const host = localHost(tenant.slug);
  const original = readFileSync(swFile, "utf8");
  try {
    await loadControlled(page, hostUrl(host), tenant.name);
    const other = await context.newPage();
    await other.goto(hostUrl(host, "/support"));
    await expect(other.getByRole("heading", { level: 1, name: "Help and support" })).toBeVisible({
      timeout: 20_000,
    });
    const oldCache = (await workerState(page)).caches[0] ?? "";

    shipNewWorker(original, "e2e-multi");
    await checkForUpdate(page);
    await expect
      .poll(async () => (await workerState(page)).waiting, { timeout: 20_000 })
      .toBe("installed");

    // A page load asks, but the other window is open: the new worker keeps waiting,
    // and the other window keeps build N's worker and cache.
    await page.reload();
    await waitForReady(page, tenant.name);
    // Past the worker's whole re-check schedule (60 seconds after the ask).
    await page.waitForTimeout(63_000);
    const held = await workerState(page);
    expect(held).toMatchObject({ active: "activated", waiting: "installed" });
    expect(held.caches).toContain(oldCache);
    expect((await workerState(other)).caches).toContain(oldCache);

    // Once it is the only window, the next page load gets the new worker,
    // within the worker's 60-second re-check schedule.
    await other.close();
    expect(context.pages()).toHaveLength(1);
    await page.reload();
    await waitForReady(page, tenant.name);
    await expect
      .poll(async () => workerState(page), { timeout: 75_000 })
      .toEqual({
        active: "activated",
        waiting: null,
        installing: null,
        caches: ["tidegrid-guest-e2e-multi"],
      });
  } finally {
    writeFileSync(swFile, original);
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
