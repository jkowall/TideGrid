import { expect, type Locator, type Page, test } from "@playwright/test";
import { collectCspViolations, hostUrl, localHost, tenantManifests } from "../helpers.ts";
import {
  account,
  clientSecret,
  installFakeApi,
  publishableKey,
  STRIPE_JS,
  tripId,
} from "./stripe-double.ts";

/**
 * The Stripe card form on the payment step (W1-STRIPE-ELEMENT), part A: the
 * built site under the guest Worker and its real CSP, with the guest API and
 * Stripe.js both doubled inside the browser (./stripe-double.ts). The page's
 * own loader adds the script from js.stripe.com, which Playwright answers
 * with the double; every other Stripe request is aborted and counted, and
 * none may happen. At 375 and 1280, as every guest browser check runs.
 *
 * The fake provider's journey is part B's, unchanged.
 */

// The page registers a service worker once its operator is ready; requests a
// worker makes would pass the page's routes, so none is allowed here.
test.use({ serviceWorkers: "block" });

const harbor = tenantManifests().find((t) => t.slug === "demo-harbor") ?? tenantManifests()[0];
if (!harbor) throw new Error("no synthetic tenant in config/tenants");
const host = localHost(harbor.slug);

/** Party, details, then the payment step. Returns the page's own response. */
async function toPayment(page: Page) {
  const response = await page.goto(hostUrl(host, `/book/${tripId}?t.adult=2`));
  await expect(page.getByRole("heading", { level: 2, name: "Who's coming" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Your details" })).toBeVisible();
  await page.getByLabel("Full name").fill("Synthetic Card Guest");
  await page.getByLabel("Email", { exact: true }).fill("synthetic.card@example.test");
  await page.getByLabel("I accept this cancellation policy").check();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible();
  return response;
}

const payButton = (page: Page) => page.getByRole("button", { name: "Pay $90.00" });

async function answers(page: Page, list: string[]) {
  await page.addInitScript((value) => {
    (window as unknown as { __stripeDouble: { answers: string[] } }).__stripeDouble = {
      answers: value,
    };
  }, list);
}

async function expectTarget(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, "the target is laid out").not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
}

/** No horizontal scroll at this width. */
async function expectNoSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("loads the card form through the loader, pays, and waits for the checkout's own state", async ({
  page,
  context,
}) => {
  const violations = collectCspViolations(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = await installFakeApi(context, page, harbor.slug, harbor.name, {
    holdPaymentRead: held,
    afterPayment: ["open", "open", "confirmed"],
  });
  await answers(page, ["succeeded"]);
  await toPayment(page);

  // Loading: a live status, and no Pay button yet.
  await expect(
    page.getByRole("status").filter({ hasText: "Loading the secure card form…" }),
  ).toBeVisible();
  await expect(payButton(page)).toHaveCount(0);
  await expect(page.getByText("This is a test payment")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simulate successful payment" })).toHaveCount(0);
  release();

  // Ready: the form in its place, the Pay button the one primary action.
  await expect(payButton(page)).toBeVisible();
  await expect(page.getByLabel("Card number")).toBeVisible();
  await expectTarget(payButton(page));
  await expectTarget(page.getByRole("button", { name: "Cancel checkout" }));
  await expectTarget(page.getByLabel("Card number"));
  await expectNoSideScroll(page);

  // The double saw only what the Bearer read gave: key, account, client secret.
  const seen = await page.evaluate(() => {
    const d = (window as unknown as { __stripeDouble: Record<string, unknown> }).__stripeDouble;
    return { factory: d.factory, elements: d.elements, created: d.created };
  });
  expect(seen).toEqual({
    factory: [{ key: publishableKey, options: { stripeAccount: account } }],
    elements: [{ clientSecret }],
    created: [
      {
        type: "payment",
        options: { layout: "tabs", wallets: { applePay: "never", googlePay: "never" } },
      },
    ],
  });
  const read = api.calls.find((c) => c.path.endsWith("/payment"));
  expect(read?.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);

  // Keyboard: the card fields, then Pay, by Tab alone; Enter pays.
  await page.getByLabel("Security code").focus();
  await page.keyboard.press("Tab");
  await expect(payButton(page)).toBeFocused();
  api.markPaid();
  await page.keyboard.press("Enter");

  // Sent: the page waits for the checkout's own state, which says confirmed only later.
  await expect(
    page.getByRole("heading", { level: 2, name: "Confirming your payment" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible({
    timeout: 20_000,
  });
  const reads = api.calls.filter(
    (c) => /\/checkout-sessions\/[^/]+$/.test(c.path) && c.method === "GET",
  );
  expect(reads.length).toBeGreaterThanOrEqual(3);

  // No secret, key, or account in the address, and none kept by the tab.
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
  for (const secret of [clientSecret, publishableKey, account]) {
    expect(page.url()).not.toContain(secret);
    expect(stored).not.toContain(secret);
  }
  expect(api.stripeAttempts).toEqual([]);
  expect(violations).toEqual([]);
});

test("shows a decline on the payment step, then pays with another card", async ({
  page,
  context,
}) => {
  const violations = collectCspViolations(page);
  const api = await installFakeApi(context, page, harbor.slug, harbor.name);
  await answers(page, ["card_declined", "succeeded"]);
  await toPayment(page);
  await payButton(page).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Your card was declined");
  await expect(alert).toContainText("Nothing was charged.");
  await expect(page.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible();
  await expectNoSideScroll(page);
  // The checkout stays open for another card: nothing was canceled.
  expect(api.calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
  api.markPaid();
  await payButton(page).click();
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible({
    timeout: 20_000,
  });
  expect(api.stripeAttempts).toEqual([]);
  expect(violations).toEqual([]);
});

test("says when the payment may have gone through, and pays again without a second charge", async ({
  page,
  context,
}) => {
  const api = await installFakeApi(context, page, harbor.slug, harbor.name);
  await answers(page, ["unknown", "succeeded"]);
  await toPayment(page);
  await payButton(page).click();
  await expect(page.getByRole("alert")).toContainText("We couldn't confirm your payment");
  await expect(page.getByRole("alert")).toContainText("nothing is paid twice");
  api.markPaid();
  await payButton(page).click();
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible({
    timeout: 20_000,
  });
});

test("shows the expired checkout when the hold runs out on the card form", async ({
  page,
  context,
}) => {
  const violations = collectCspViolations(page);
  const api = await installFakeApi(context, page, harbor.slug, harbor.name, { holdMs: 8_000 });
  await answers(page, ["succeeded"]);
  await toPayment(page);
  await expect(payButton(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your checkout expired" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(payButton(page)).toHaveCount(0);
  await expectNoSideScroll(page);
  expect(api.stripeAttempts).toEqual([]);
  expect(violations).toEqual([]);
});

test("offers Try again when Stripe.js does not load, and loads it on request", async ({
  page,
  context,
}) => {
  const api = await installFakeApi(
    context,
    page,
    harbor.slug,
    harbor.name,
    {},
    {
      stripeJs: "fail-until-allowed",
    },
  );
  await toPayment(page);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The card form couldn't load", { timeout: 30_000 });
  await expect(payButton(page)).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Try again" });
  await expectTarget(retry);
  // Cancel checkout stays in reach to release the seats.
  await expectTarget(page.getByRole("button", { name: "Cancel checkout" }));
  await expectNoSideScroll(page);
  api.allowStripeJs();
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(payButton(page)).toBeVisible({ timeout: 20_000 });
  expect(api.stripeAttempts).toEqual([]);
});

test("loads Stripe.js only from its own address, under the page's policy", async ({
  page,
  context,
}) => {
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  await installFakeApi(context, page, harbor.slug, harbor.name);
  const response = await toPayment(page);
  await expect(payButton(page)).toBeVisible();
  expect(scripts.filter((url) => !url.startsWith(hostUrl(host, "/")))).toEqual([STRIPE_JS]);
  const csp = response?.headers()["content-security-policy"];
  expect(csp).toContain(
    "script-src 'self' https://static.cloudflareinsights.com https://js.stripe.com",
  );
  expect(csp).toContain(
    "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
  );
});
