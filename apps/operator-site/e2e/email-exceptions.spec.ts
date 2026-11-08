import { expect, type Page, type Route, test } from "@playwright/test";
import { cspViolations, deployed, signIn } from "./helpers.ts";

/**
 * The operator's email exceptions (W1-EMAIL-EXC), at 375 and 1280, through
 * the console Worker under its real configuration, CSP included. Booking
 * staff and the owner at Demo Harbor; finance at Demo Harbor.
 *
 * The seed fails no email, so the list's answers are served from this file
 * (page.route) for the loading, error, empty, and populated states; sign-in
 * and the shell use the real API. The finance test proves no list request
 * leaves at all. The API's own rules (roles, two tenants, paging) are proven
 * in the integration suites.
 *
 * 1. the loading state, then a populated list: each row's name, state badge,
 *    and booking link, with no page-wide horizontal scroll;
 * 2. an error with Try again, then the empty state;
 * 3. the keyboard: from the rail's entry to the list, then each row's link
 *    and Show older, and Enter on a link opens the booking at #email;
 * 4. finance gets no entry and, at the address, a refusal with no request.
 *
 * Local only: the whole file is skipped in deployed mode (Nov 1 runbook, P6
 * steps 5 and 7, which keep their earlier test list). It reads no environment
 * at load.
 */

const staff = "ben.desk@demo-harbor.test";
const owner = "ava.owner@demo-harbor.test";
const finance = "fay.books@demo-harbor.test";
const listUrl = "**/api/v1/staff/tenants/*/email-exceptions*";

const bookingA = "0b5e3c1a-7d2f-4e8a-9c61-1a2b3c4d5e01";
const bookingB = "0b5e3c1a-7d2f-4e8a-9c61-1a2b3c4d5e02";

function exception(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
    template: "booking_confirmation",
    kind: "booking",
    state: "failed",
    attempts: 1,
    failureCode: "bounced",
    failedAt: "2026-11-04T14:00:03.000Z",
    staffResend: false,
    laterSent: false,
    booking: { id: bookingA, reference: "QKG6ERBF", timeZone: "America/New_York" },
    ...over,
  };
}

const populated = {
  exceptions: [
    exception(1, { state: "outcome_unknown", failureCode: "outcome_unknown" }),
    exception(2, {
      template: "booking_canceled",
      state: "delivery_failed",
      failureCode: "delivery_failed",
      attempts: 2,
      staffResend: true,
      laterSent: true,
    }),
    exception(3, {
      template: "waiver_request",
      kind: "waiver",
      booking: { id: bookingB, reference: "ZX9KP2QM", timeZone: "America/New_York" },
    }),
  ],
  nextBefore: "00000000-0000-4000-9000-000000000003",
};

const fulfill = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });

/** The page has its answer: no skeleton and no loading words. */
async function settled(page: Page) {
  await expect(page.locator(".ex-list--skeleton")).toHaveCount(0, { timeout: 20_000 });
}

/** The list's own live region. */
const listStatus = (page: Page) => page.locator(".ee > [role='status']");

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "no page-wide horizontal scroll").toBeLessThanOrEqual(0);
}

test.describe("the email exceptions list (W1-EMAIL-EXC)", () => {
  test.skip(deployed, "local only: the Nov 1 acceptance runs keep their earlier test list");

  test("loads, then lists each exception with its state and its booking's card", async ({
    page,
  }) => {
    const violations = cspViolations(page);
    await signIn(page, staff);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(listUrl, async (route) => {
      await held;
      await fulfill(route, 200, populated);
    });
    await page
      .getByRole("navigation", { name: "Console" })
      .getByRole("link", {
        name: "Email exceptions",
      })
      .click();
    await expect(page).toHaveURL(/\/email-exceptions$/);
    await expect(page.getByRole("heading", { level: 1, name: "Email exceptions" })).toBeFocused();

    // 1. Loading: a skeleton hidden from assistive technology, and words that are not.
    await expect(page.locator(".ex-list--skeleton")).toBeVisible();
    await expect(page.locator(".ex-list--skeleton")).toHaveAttribute("aria-hidden", "true");
    await expect(listStatus(page)).toHaveText("Loading email exceptions…");
    await noSideScroll(page);
    release();
    await settled(page);

    const rows = page.locator(".ex-list > li");
    await expect(rows).toHaveCount(3);
    await expect(rows.locator("h2")).toHaveText([
      "Confirmation",
      "Cancellation notice, Sent again by staff",
      "Waiver request",
    ]);
    await expect(rows.locator(".tg-status")).toHaveText([
      "Outcome unknown",
      "Delivery failed",
      "Failed",
    ]);
    await expect(rows.nth(1)).toContainText("was taken by the email service");
    await expect(listStatus(page)).toHaveText("3 email exceptions shown, with older ones to load.");
    const links = rows.getByRole("link");
    await expect(links).toHaveText([
      "Booking QKG6ERBF, Email card",
      "Booking QKG6ERBF, Email card",
      "Booking ZX9KP2QM, Waivers card",
    ]);
    await expect(links.first()).toHaveAttribute("href", `/bookings/${bookingA}#email`);
    await expect(links.nth(2)).toHaveAttribute("href", `/bookings/${bookingB}`);
    // Each link is a 44 px target.
    for (const box of await Promise.all((await links.all()).map((l) => l.boundingBox()))) {
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole("main")).not.toContainText("@");
    await noSideScroll(page);
    expect(violations).toEqual([]);
  });

  test("shows a designed error with Try again, then the empty state", async ({ page }) => {
    await signIn(page, owner);
    let calls = 0;
    await page.route(listUrl, async (route) => {
      calls += 1;
      if (calls === 1) {
        await fulfill(route, 503, {
          error: { code: "unavailable", message: "unavailable", requestId: "e2e" },
        });
        return;
      }
      await fulfill(route, 200, { exceptions: [], nextBefore: null });
    });
    await page.goto("/email-exceptions");
    await expect(page.getByText("Email exceptions didn't load")).toBeVisible({ timeout: 20_000 });
    await noSideScroll(page);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "No email exceptions" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Email exceptions" })).toBeFocused();
    await expect(listStatus(page)).toHaveText("No email exceptions.");
    await noSideScroll(page);
    expect(calls).toBe(2);
  });

  test("reaches the entry, each row's link, and Show older by keyboard, and opens the booking at #email", async ({
    page,
  }) => {
    await signIn(page, staff);
    await page.route(listUrl, (route) => fulfill(route, 200, populated));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

    // From the top of the page to the rail's entry, by Tab alone.
    const entry = page
      .getByRole("navigation", { name: "Console" })
      .getByRole("link", { name: "Email exceptions" });
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await entry.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab reaches the Email exceptions entry").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/email-exceptions$/);
    await settled(page);
    await expect(page.getByRole("heading", { level: 1, name: "Email exceptions" })).toBeFocused();

    // From the heading: each row's link, then Show older.
    const links = page.locator(".ex-list").getByRole("link");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Tab");
      await expect(links.nth(i)).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Show older email exceptions" })).toBeFocused();

    // Back to the first link, and Enter opens its booking at the Email card.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+Tab");
    await expect(links.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/bookings/${bookingA}#email$`));
  });

  test("gives finance no entry, and at the address a refusal with no request", async ({ page }) => {
    await signIn(page, finance);
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/email-exceptions")) asked.push(request.url());
    });
    const nav = page.getByRole("navigation", { name: "Console" });
    await expect(nav.getByRole("link", { name: "Exceptions", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Email exceptions" })).toHaveCount(0);
    await page.goto("/email-exceptions");
    await expect(
      page.getByRole("heading", { level: 2, name: "Your role can't see email exceptions" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("link", { name: "Go to bookings" })).toBeVisible();
    await noSideScroll(page);
    expect(asked.filter((url) => url.includes("/api/"))).toEqual([]);
  });
});
