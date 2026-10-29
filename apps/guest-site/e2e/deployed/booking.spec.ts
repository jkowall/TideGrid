import { expect, type Page, test } from "@playwright/test";
import {
  type DeployedHost,
  daysFromToday,
  deployedHosts,
  hostPath,
  perTenantHosts,
  syntheticEmail,
} from "../deployed-helpers.ts";

/**
 * P6 steps 2 and 4 on the deployed guest hosts (Nov 1 runbook), through the
 * guest UI and the fake payment provider:
 *
 * - Demo Reef: a shared-seat "Two-Tank Morning Dive" at least 3 days out with
 *   promotion code REEF25, the party named through the management session
 *   the confirmation opens ("Name your party now"), then canceled within
 *   policy there, which must give a full refund.
 * - Demo Harbor: a "Private Half-Day Charter" at least 8 days out, on a
 *   Saturday or Sunday, with its party named the same way.
 *
 * The seeded terms it relies on (tools/seed/src/catalog.ts and pricing.ts):
 * the dive runs Monday to Saturday at 07:30 Honolulu time, takes up to 6 per
 * party, and refunds in full before its 2,880-minute (48-hour) change cutoff;
 * REEF25 takes 25 dollars off the dive; the charter runs on Saturdays and
 * Sundays only, with a 10,080-minute (7-day) cutoff. Searching from 4 and 9
 * days after today (UTC) keeps each departure past those cutoffs on any clock.
 *
 * Desktop only: each booking spends public commands against the 30 per
 * minute per tenant limit. Per-tenant preview hosts only: the single-origin
 * rerun at cutover is step 1 alone. Every booker and guest is a synthetic
 * address at a reserved .test domain. Each booking prints one JSON line with
 * its reference; the Reef line adds its booking id, trip id, and local date,
 * which step 7's deployed isolation run takes as its E2E_FOREIGN_* inputs.
 */

const hosts = deployedHosts();
const reef = hosts.find((h) => h.slug === "demo-reef");
const harbor = hosts.find((h) => h.slug === "demo-harbor");
const party = 2;

function skipUnlessDesktopPreview() {
  test.skip(test.info().project.name !== "desktop", "desktop only, to save the public rate budget");
  test.skip(!perTenantHosts(), "step 2 runs on the per-tenant preview hosts only");
}

function required(host: DeployedHost | undefined, slug: string): DeployedHost {
  if (!host) throw new Error(`no deployed host for ${slug}`);
  return host;
}

/**
 * From the trips list, the first Book link for a product, starting `from`.
 * The link's name reads "Book <product>, <weekday>, <date>, <time>"; `day`
 * narrows it to some weekdays.
 */
async function openTrip(page: Page, host: DeployedHost, product: string, from: string, day = "") {
  await page.goto(hostPath(host, `/?from=${from}&party=${party}`));
  await expect(page.getByRole("heading", { level: 1, name: host.name })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("status").filter({ hasText: /trips? from/ })).toBeAttached({
    timeout: 20_000,
  });
  const book = page.getByRole("link", { name: new RegExp(`^Book ${product}, ${day}`) }).first();
  await expect(
    book,
    `a ${product} with room for ${party} in the 4 weeks from ${from}`,
  ).toBeVisible();
  await book.click();
}

/** Party, details, and the shim's successful payment, to the booking reference. */
async function bookAndPay(
  page: Page,
  options: { partyHeading: string; promotion?: string; booker: { name: string; email: string } },
): Promise<string> {
  await expect(page.getByRole("heading", { level: 2, name: options.partyHeading })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Your details" })).toBeVisible({
    timeout: 20_000,
  });
  if (options.promotion) {
    const code = page.getByLabel("Promotion code (optional)");
    await expect(code).toBeEnabled({ timeout: 20_000 });
    await code.fill(options.promotion);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator(".booking-promo__applied")).toContainText(
      `Code ${options.promotion} applied.`,
      { timeout: 20_000 },
    );
  }
  await page.getByLabel("Full name").fill(options.booker.name);
  await page.getByLabel("Email", { exact: true }).fill(options.booker.email);
  await page.getByLabel("I accept this cancellation policy").check();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("This is a demo test payment")).toBeVisible();
  await page.getByRole("button", { name: "Simulate successful payment" }).click();
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible({
    timeout: 30_000,
  });
  const reference = (
    await page.locator('.booking-reference__code [aria-hidden="true"]').textContent()
  )?.trim();
  expect(reference, "the confirmed booking's reference").toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  return reference as string;
}

/** Open the booking from the checkout, then name each guest. */
async function nameParty(page: Page, product: string, label: string) {
  await page.getByRole("button", { name: "Name your party now" }).click();
  await expect(page.getByRole("heading", { level: 1, name: product })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { level: 2, name: "Who's coming" })).toBeVisible();
  for (let position = 1; position <= party; position++) {
    await page.getByRole("button", { name: `Add guest ${position}` }).click();
    await page.getByLabel("Full name").fill(`Synthetic ${label} Guest ${position}`);
    await page
      .getByLabel("Their email (optional)")
      .fill(syntheticEmail(`${label.toLowerCase()}.g${position}`));
    await page.getByRole("button", { name: `Save guest ${position}` }).click();
    await expect(page.getByText(`is guest ${position}.`)).toBeVisible({ timeout: 20_000 });
  }
}

test("Demo Reef: a shared-seat dive with REEF25, its party named, then canceled for a full refund", async ({
  page,
}) => {
  skipUnlessDesktopPreview();
  test.setTimeout(180_000);
  const host = required(reef, "demo-reef");
  const product = "Two-Tank Morning Dive";
  await openTrip(page, host, product, daysFromToday(4));
  const reference = await bookAndPay(page, {
    partyHeading: "Who's coming",
    promotion: "REEF25",
    booker: { name: "Synthetic Reef Booker", email: syntheticEmail("reef") },
  });
  await nameParty(page, product, "Reef");

  // Step 4: cancel within policy through the same management session.
  const cancel = page.getByRole("region", { name: "Cancel this booking" });
  await expect(cancel).toContainText("You get a full refund of");
  await cancel.getByRole("button", { name: "Cancel booking" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("You get a full refund of");
  const answered = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/v1/public/manage/cancellation"),
  );
  await dialog.getByRole("button", { name: "Cancel booking" }).click();
  const response = await answered;
  expect(response.status()).toBe(200);
  const { booking } = (await response.json()) as {
    booking: {
      id: string;
      reference: string;
      state: string;
      trip: { tripId: string; localDate: string };
      cancellation: {
        remedy: string;
        refundBp: number;
        refundAmount: number;
        paidAmount: number;
        beforeCutoff: boolean;
      } | null;
    };
  };
  expect(booking.reference).toBe(reference);
  expect(booking.state).toBe("canceled");
  expect(booking.cancellation).toMatchObject({
    remedy: "full_refund",
    refundBp: 10_000,
    beforeCutoff: true,
  });
  expect(booking.cancellation?.refundAmount).toBe(booking.cancellation?.paidAmount);
  await expect(page.getByText("Your booking is canceled")).toBeVisible({ timeout: 20_000 });

  console.log(
    JSON.stringify({
      check: "booking",
      tenant: host.slug,
      product,
      reference,
      canceled: booking.cancellation?.remedy,
      // Ids only, for step 7's E2E_FOREIGN_* inputs; no personal data.
      bookingId: booking.id,
      tripId: booking.trip.tripId,
      localDate: booking.trip.localDate,
    }),
  );
});

test("Demo Harbor: a weekend private charter, its party named", async ({ page }) => {
  skipUnlessDesktopPreview();
  test.setTimeout(180_000);
  const host = required(harbor, "demo-harbor");
  const product = "Private Half-Day Charter";
  // The charter runs on weekends only; the link's name says so as well.
  await openTrip(page, host, product, daysFromToday(9), "(Saturday|Sunday), ");
  const reference = await bookAndPay(page, {
    partyHeading: "Your group",
    booker: { name: "Synthetic Harbor Booker", email: syntheticEmail("harbor") },
  });
  await nameParty(page, product, "Harbor");
  console.log(JSON.stringify({ check: "booking", tenant: host.slug, product, reference }));
});
