import { expect, test } from "@playwright/test";
import {
  collectCspViolations,
  hostUrl,
  installability,
  localHost,
  registerServiceWorker,
  serviceWorkerState,
  tenantManifests,
} from "../helpers.ts";

/**
 * Part A of the two-brand journey (G2.14b): the built guest site under the
 * guest Worker, with a stub GuestGateway and no database or API. The page's
 * bootstrap fails here (no API), so the tests register the service worker
 * themselves, as the page does once its operator is ready.
 */

const tenants = tenantManifests();

for (const tenant of tenants) {
  test(`${tenant.slug}: serves only its own manifest, theme color, and icons`, async ({ page }) => {
    const host = localHost(tenant.slug);
    const res = await page.request.get(hostUrl(host, "/manifest.webmanifest"));
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/manifest+json");
    const manifest = await res.json();
    expect(manifest).toMatchObject({
      name: tenant.name,
      theme_color: tenant.primary,
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    for (const other of tenants.filter((t) => t.slug !== tenant.slug)) {
      expect(JSON.stringify(manifest)).not.toContain(other.name);
    }
    for (const icon of manifest.icons as { src: string }[]) {
      const image = await page.request.get(hostUrl(host, icon.src));
      expect(image.status()).toBe(200);
      expect(image.headers()["content-type"]).toBe("image/svg+xml");
      expect(image.headers()["content-security-policy"]).toBe(
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(await image.text()).toContain(`fill="${tenant.primary}"`);
    }
  });

  test(`${tenant.slug}: Chromium reads the manifest, and the service worker installs`, async ({
    page,
  }) => {
    const violations = collectCspViolations(page);
    await page.goto(hostUrl(localHost(tenant.slug)));
    await registerServiceWorker(page);
    const { manifest, installabilityErrors } = await installability(page);
    expect(manifest.url).toBe(hostUrl(localHost(tenant.slug), "/manifest.webmanifest"));
    expect(manifest.errors).toEqual([]);
    expect(JSON.parse(manifest.data ?? "{}").name).toBe(tenant.name);
    // The first run decides D3: an SVG-only icon set must report no errors.
    // Recorded in the CI log as installability evidence.
    console.log(
      `installability ${tenant.slug}: ${JSON.stringify({ manifestErrors: manifest.errors, installabilityErrors })}`,
    );
    test.info().annotations.push({
      type: "installability",
      description: JSON.stringify(installabilityErrors),
    });
    // Every test context is an incognito-style profile, which Chromium never
    // offers to install from; that one error is about the browser, not the site.
    if (installabilityErrors) {
      expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);
    }
    expect(violations).toEqual([]);
  });
}

test("a definite miss gets a 404 manifest and the kill switch, which clears itself", async ({
  page,
}) => {
  const host = "nobody.book.localhost";
  const manifest = await page.request.get(hostUrl(host, "/manifest.webmanifest"));
  expect(manifest.status()).toBe(404);
  expect(manifest.headers()["cache-control"]).toBe("no-store");
  const sw = await page.request.get(hostUrl(host, "/sw.js"));
  expect(sw.status()).toBe(200);
  expect(sw.headers()["clear-site-data"]).toBe('"cache"');
  expect(await sw.text()).toContain("unregister");

  await page.goto(hostUrl(host));
  await page.evaluate(async () => {
    await caches.open("left-behind");
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  });
  await expect
    .poll(async () => serviceWorkerState(page), { timeout: 15_000 })
    .toEqual({ registrations: 0, caches: [] });
});

test("a gateway outage is 503 and keeps the installed worker and its caches", async ({ page }) => {
  for (const path of ["/manifest.webmanifest", "/sw.js", "/icons/icon.svg"]) {
    const res = await page.request.get(hostUrl("throws.book.localhost", path));
    expect(res.status()).toBe(503);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["clear-site-data"]).toBeUndefined();
    expect(await res.text()).not.toContain("unregister");
  }
});

test("Worker answers carry their own security headers", async ({ page }) => {
  for (const [host, path] of [
    [localHost(tenants[0]?.slug ?? "demo-harbor"), "/manifest.webmanifest"],
    [localHost(tenants[0]?.slug ?? "demo-harbor"), "/sw.js"],
    ["nobody.book.localhost", "/manifest.webmanifest"],
    ["throws.book.localhost", "/sw.js"],
  ] as const) {
    const res = await page.request.get(hostUrl(host, path));
    const headers = res.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["content-security-policy"]).toMatch(/^default-src 'none'/);
  }
  // The page itself keeps the strict policy, with worker-src and manifest-src.
  const page404 = await page.request.get(hostUrl(localHost("demo-harbor"), "/"));
  expect(page404.headers()["content-security-policy"]).toMatch(
    /worker-src 'self'; manifest-src 'self'/,
  );
});

test("with the network cut, a navigation shows the neutral offline page", async ({
  page,
  context,
}) => {
  const host = localHost(tenants[1]?.slug ?? "demo-reef");
  await page.goto(hostUrl(host));
  await registerServiceWorker(page);
  // The worker controls the page from the next navigation.
  await page.reload();
  await context.setOffline(true);
  await page.goto(hostUrl(host, "/manage#t=not-a-real-token"));
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(tenants[1]?.name ?? "Demo Reef");
  await context.setOffline(false);
  const { caches } = await serviceWorkerState(page);
  expect(caches.length).toBe(1);
  const keys = await page.evaluate(async (name) => {
    const cache = await window.caches.open(name);
    return (await cache.keys()).map((r) => r.url);
  }, caches[0] ?? "");
  for (const key of keys) {
    expect(key).not.toMatch(/#|\/manage|\/waiver|\/book\/|localhost:8961|api\.tidegrid\.us/);
  }
  expect(keys.some((k) => k.endsWith("/__offline"))).toBe(true);
});
