import { expect, type Frame, type Page, test } from "@playwright/test";
import { collectCspViolations, hostUrl, localHost, tenantManifests } from "../helpers.ts";

/**
 * The phone app demo (W1N-WEB): the demo guest app (apps/guest-native),
 * built for the browser into /app/, shown on /phone/ inside a phone frame on
 * a desktop and full screen on a phone. It runs against the API on :8961 with
 * the host's own Origin, like the guest site, and uses the demo's test
 * provider to pay.
 */

const harbor = tenantManifests().find((t) => t.slug === "demo-harbor");

/**
 * Every securitypolicyviolation event, in the page and in its frames.
 * Chromium logs no console line for some, such as an eval probe.
 */
async function watchPolicy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (globalThis as unknown as { __violations: string[] }).__violations = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
}

async function policyEvents(...targets: (Page | Frame)[]): Promise<string[]> {
  const all: string[] = [];
  for (const target of targets) {
    all.push(
      ...(await target.evaluate(
        () => (globalThis as unknown as { __violations?: string[] }).__violations ?? [],
      )),
    );
  }
  return all;
}

function appFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes("/app/"));
  if (!frame) throw new Error("the app frame is missing");
  return frame;
}

test("on a desktop, the phone frame shows the app, and a trip books inside it", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "desktop", "the frame is for wide screens");
  if (!harbor) throw new Error("demo-harbor is missing from config/tenants");
  const violations = collectCspViolations(page);
  await watchPolicy(page);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(hostUrl(localHost("demo-harbor"), "/phone/"));
  await expect(page.getByRole("heading", { level: 1, name: "The guest phone app" })).toBeVisible();
  const app = page.frameLocator('iframe[title="TideGrid guest app"]');
  await expect(app.getByText(harbor.name).first()).toBeVisible({ timeout: 20_000 });

  await app.getByText("Sunset Harbor Cruise").first().click();
  await app.getByText("Continue", { exact: true }).click();
  await app.getByLabel("Full name").fill("Pat Demo");
  await app.getByLabel("Email").fill("pat.phone@example.test");
  await app.locator("input[type=checkbox]").click();
  await app.getByText("Continue to payment").click();
  await expect(app.getByText("Simulate successful payment")).toBeVisible({ timeout: 20_000 });

  // Back on the payment step asks first, with the browser's own dialog.
  await app.getByText("‹ Back").click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain("Leave checkout?");
  await expect(app.getByText("Simulate successful payment")).toBeVisible();

  await app.getByText("Simulate successful payment").click();
  await expect(app.getByText("You're booked")).toBeVisible({ timeout: 30_000 });
  await app.getByText("View your booking").click();
  await expect(app.getByText(/demo test payment/)).toBeVisible();
  expect(violations).toEqual([]);
  expect(await policyEvents(page, appFrame(page))).toEqual([]);
});

test("on a phone, the link opens the app full screen", async ({ page }) => {
  test.skip(test.info().project.name !== "phone", "phones skip the frame");
  if (!harbor) throw new Error("demo-harbor is missing from config/tenants");
  const violations = collectCspViolations(page);
  await watchPolicy(page);
  await page.goto(hostUrl(localHost("demo-harbor"), "/phone/"));
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByText(harbor.name).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Upcoming trips")).toBeVisible();
  expect(violations).toEqual([]);
  expect(await policyEvents(page)).toEqual([]);
});

test("the app may be framed only by its own host, and the frame page by nobody", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "desktop", "runs once");
  // Through the browser, which resolves *.localhost to this machine.
  const app = await page.goto(hostUrl(localHost("demo-harbor"), "/app/"));
  expect(app?.status()).toBe(200);
  const appPolicy = app?.headers()["content-security-policy"] ?? "";
  expect(appPolicy).toContain("frame-ancestors 'self'");
  expect(appPolicy).toContain("script-src 'self';");
  expect(appPolicy).not.toContain("stripe");
  const frame = await page.goto(hostUrl(localHost("demo-harbor"), "/phone/"));
  expect(frame?.status()).toBe(200);
  const framePolicy = frame?.headers()["content-security-policy"] ?? "";
  expect(framePolicy).toContain("frame-ancestors 'none'");
  expect(framePolicy).toContain("frame-src 'self'");
});
