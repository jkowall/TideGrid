import { expect, type Page, test } from "@playwright/test";
import { deployedHosts, hostPath } from "../deployed-helpers.ts";
import { collectCspViolations, installability, tenantManifests } from "../helpers.ts";

/**
 * P6 step 1 on the deployed guest hosts (Nov 1 runbook): the portable part of
 * e2e/full/journey.spec.ts, at 375 and 1280. Each host shows its own brand on
 * every page, its manifest is installable, a service worker controls the
 * page, and no manage or waiver token or API answer is kept in CacheStorage.
 * One screenshot per host and project goes to the test's output path, which
 * deployed mode keeps in $NOV1_PRIVATE_DIR/traces.
 *
 * Not ported: the service worker update tests, the unknown-host test, and the
 * disable test. They need a local build, an admin URL, or a permanent change.
 */

const hosts = deployedHosts();
const tenants = tenantManifests();

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

for (const host of hosts) {
  test(`${host.slug}: its own brand on every page, an installable app, and a service worker`, async ({
    page,
  }, testInfo) => {
    const violations = collectCspViolations(page);
    await page.goto(hostPath(host));
    await waitForReady(page, host.name);
    expect(await controlled(page)).toBe(true);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", host.primary);
    await page.screenshot({
      path: testInfo.outputPath(`${host.slug}-${testInfo.project.name}.png`),
      fullPage: true,
    });

    for (const [path, heading] of [
      ["/support", "Help and support"],
      ["/offline", "Using this site offline"],
      ["/terms", "Terms of booking"],
      ["/privacy", "Privacy notice"],
      ["/legal/terms", "Terms of booking"],
    ] as const) {
      await page.goto(hostPath(host, path));
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({
        timeout: 20_000,
      });
      if (path === "/offline") await expect(page.locator("body")).not.toContainText(host.name);
      else await expect(page.locator("footer")).toContainText(host.name);
      for (const other of tenants.filter((t) => t.slug !== host.slug)) {
        await expect(page.locator("body")).not.toContainText(other.name);
      }
    }

    const { manifest, installabilityErrors } = await installability(page);
    expect(manifest.errors).toEqual([]);
    expect(JSON.parse(manifest.data ?? "{}")).toMatchObject({
      name: host.name,
      theme_color: host.primary,
    });
    // One JSON line per host and project, the installability evidence.
    console.log(
      JSON.stringify({
        check: "installability",
        host: new URL(host.origin).hostname,
        project: testInfo.project.name,
        manifestErrors: manifest.errors,
        installabilityErrors,
      }),
    );
    testInfo.annotations.push({
      type: "installability",
      description: JSON.stringify(installabilityErrors),
    });
    if (installabilityErrors) {
      expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);
    }
    expect(violations).toEqual([]);
  });

  test(`${host.slug}: manage and waiver links leave no token or API answer in CacheStorage`, async ({
    page,
  }) => {
    await page.goto(hostPath(host));
    await waitForReady(page, host.name);
    await controlled(page);
    await page.reload();
    await waitForReady(page, host.name);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    // Link-shaped addresses with synthetic tokens. The page redeems a token
    // only on an explicit action, and the cache rules hold either way.
    await page.goto(hostPath(host, "/manage#t=e2e-manage-token-0123456789abcdef"));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    await page.goto(hostPath(host, "/waiver#t=e2e-waiver-token-0123456789abcdef"));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    const keys = await cacheKeys(page);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/#|t=|\/manage|\/waiver|\/book\//);
      expect(key).not.toContain("api.tidegrid.us");
    }
  });
}
