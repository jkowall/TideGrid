import { expect, type Page, type Route, test } from "@playwright/test";
import { cspViolations, deployed, signIn } from "./helpers.ts";

/**
 * Following up a payment exception (W1-FIN-EXC), at 375 and 1280, through
 * the console Worker under its real configuration, CSP included. Booking
 * staff at Demo Harbor: Finn Desk, whom `local-db.sh prepare console-e2e`
 * adds for this file alone, so no other spec's sign-in budget (5 links in
 * 15 minutes) is touched. One test a width: 2 links a run.
 *
 * The seed raises no payment exception, so the list and the resolve answers
 * are served from this file (page.route); sign-in and the shell use the real
 * API. The API's own rules (roles, two tenants, replay, money untouched) are
 * proven in the integration suites.
 *
 * Local only: skipped in deployed mode. It reads no environment at load.
 */

const staff = "finn.desk@demo-harbor.test";
const listUrl = "**/api/v1/staff/tenants/*/finalization-exceptions?*";
const resolveUrl = "**/api/v1/staff/tenants/*/finalization-exceptions/*/resolution";

function exception(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
    reason: "no_capacity",
    checkoutSessionId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    tripId: "00000000-0000-4000-a000-000000000001",
    paymentId: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`,
    amount: 13109,
    createdAt: "2026-11-04T18:40:00.000Z",
    refund: {
      id: `00000000-0000-4000-c000-${String(n).padStart(12, "0")}`,
      state: "succeeded",
      amount: 13109,
      failureCode: null,
      settledAt: "2026-11-04T18:42:00.000Z",
    },
    trip: {
      tripId: "00000000-0000-4000-a000-000000000001",
      productName: "Sunset Harbor Cruise",
      productKind: "shared_seat",
      boatName: "Sea Lark",
      timeZone: "America/New_York",
      localDate: "2026-11-06",
      localStartTime: "18:00",
      startsAt: "2026-11-06T23:00:00.000Z",
      salesState: "published",
    },
    partySize: 3,
    checkout: { state: "unfulfilled", expiresAt: "2026-11-04T18:25:00.000Z" },
    payment: {
      provider: "fake",
      providerReference: "fpay_••••c3D4",
      receivedAt: "2026-11-04T18:40:00.000Z",
      reportedAmount: 13109,
      reportedCurrency: "USD",
    },
    booker: { name: "Synthetic Guest", email: "synthetic.guest@example.test" },
    resolution: null,
    ...over,
  };
}

const resolution = {
  id: "00000000-0000-4000-d000-000000000001",
  reasonCode: "contacted_guest",
  resolvedBy: { userId: "00000000-0000-4000-e000-000000000001", name: "Finn Desk" },
  resolvedAt: "2026-11-08T15:00:00.000Z",
};
const note = "Called the guest back. Rebooked them for Friday.";

const fulfill = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "no page-wide horizontal scroll").toBeLessThanOrEqual(0);
}

test.describe("following up a payment exception (W1-FIN-EXC)", () => {
  test.skip(deployed, "local only: the Nov 1 acceptance runs keep their earlier test list");

  test("marks one as followed up by keyboard, then finds it under Followed up", async ({
    page,
  }) => {
    const violations = cspViolations(page);
    await signIn(page, staff);
    const sent: unknown[] = [];
    let resolved = false;
    await page.route(listUrl, (route) => {
      const status = new URL(route.request().url()).searchParams.get("status");
      if (status === "resolved") {
        return fulfill(route, 200, {
          exceptions: resolved ? [exception(1, { resolution: { ...resolution, note } })] : [],
          nextBefore: null,
        });
      }
      return fulfill(route, 200, {
        exceptions: resolved ? [exception(2)] : [exception(1), exception(2)],
        nextBefore: null,
      });
    });
    await page.route(resolveUrl, (route) => {
      sent.push(route.request().postDataJSON());
      resolved = true;
      return fulfill(route, 201, { exceptionId: exception(1).id, resolution });
    });
    await page.goto("/exceptions");
    const items = page.locator("li.ex-item");
    await expect(items).toHaveCount(2, { timeout: 20_000 });
    await noSideScroll(page);

    // Open the form from its button by keyboard: focus lands on the reason.
    const mark = items.first().getByRole("button", { name: "Mark as followed up" });
    await expect(mark).toBeVisible();
    const box = await mark.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await mark.focus();
    await page.keyboard.press("Enter");
    const reason = page.getByLabel("How did you follow it up?");
    await expect(reason).toBeFocused();
    await reason.selectOption("contacted_guest");
    await page.keyboard.press("Tab");
    const noteField = page.getByLabel("Note (optional)");
    await expect(noteField).toBeFocused();
    await page.keyboard.type(note);
    await noSideScroll(page);
    await page.keyboard.press("Tab");
    const save = items.first().locator("form").getByRole("button", { name: "Mark as followed up" });
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");

    // The item leaves the open list; focus moves to the next one's heading.
    await expect(items).toHaveCount(1);
    expect(sent).toEqual([{ reasonCode: "contacted_guest", note }]);
    await expect(items.first().locator("h2")).toBeFocused();
    await expect(page.locator(".ex > [role='status']")).toContainText("Marked as followed up");

    // The history shows who, the reason, and the note.
    await page.getByLabel("Show").selectOption("resolved");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Contacted the guest");
    await expect(items.first()).toContainText("Finn Desk");
    await expect(items.first()).toContainText(note);
    await expect(items.first().getByRole("button")).toHaveCount(0);
    await noSideScroll(page);
    expect(violations).toEqual([]);
  });
});
