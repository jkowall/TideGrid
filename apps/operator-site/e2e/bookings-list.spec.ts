import { expect, type Page, test } from "@playwright/test";
import { cspViolations, deployed, signIn } from "./helpers.ts";

/**
 * The day list by source (G2.12e), at 375 and 1280, through the console
 * Worker and the API under their real configuration, CSP included. Booking
 * staff at Demo Harbor:
 *
 * 1. find the first day from today with trips, which the staff booking
 *    journey never books (it books from next week on), and check it holds no
 *    staff booking;
 * 2. filter it to staff bookings: the address keeps the source, the counts
 *    and a trip shown alone say none, and Show all sources brings the rest
 *    back;
 * 3. the source survives a reload and Next, and the trip does not;
 * 4. Book in a trip's header is a 44 px target that opens the new booking
 *    page for that trip (nothing is booked);
 * 5. at 1280, a staff booking's badge, where one is listed in the next two
 *    weeks, sits under its reference in the first column.
 *
 * The positive badge and the filtered rows are proven in jsdom and the
 * integration suites: the seed has no staff-assisted bookings.
 *
 * Local only. The file is safe to load in deployed mode (Nov 1 runbook, P6
 * steps 5 and 7, which collect every spec): it reads no environment at load,
 * signs in only inside a test, and the whole file is skipped there.
 */

const staff = "ben.desk@demo-harbor.test";

/** The list's day has loaded: its trips, or its empty state. */
async function dayLoaded(page: Page) {
  await page.locator(".bk-trip h3, .bk .tg-empty").first().waitFor({ timeout: 20_000 });
  await expect(page.locator(".bk-skeleton")).toHaveCount(0);
  await expect(page.locator('.bk-day[aria-busy="true"]')).toHaveCount(0);
}

const params = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);

test.describe("the day list by source (G2.12e)", () => {
  test.skip(deployed, "local only: G2.12e is not part of the Nov 1 deploy");

  test("filters a day by source, keeps it in the address, and books from a trip header", async ({
    page,
  }, info) => {
    const violations = cspViolations(page);
    await signIn(page, staff);
    await page.goto("/bookings");
    await dayLoaded(page);

    // 1. The first day from today with trips, before next week.
    for (let i = 0; i < 6 && (await page.locator(".bk-trip h3").count()) === 0; i++) {
      await page.getByRole("button", { name: "Next day" }).click();
      await dayLoaded(page);
    }
    const trips = page.locator(".bk-trip h3");
    expect(await trips.count(), "a day with trips this week").toBeGreaterThan(0);
    const day = params(page).day;

    // 2. Staff bookings only: none on this day.
    const source = page.getByRole("combobox", { name: "Source" });
    await source.selectOption("staff_assisted");
    await expect.poll(() => params(page).source).toBe("staff_assisted");
    await dayLoaded(page);
    await expect(page.locator(".bk-filters__totals")).toHaveText("No staff bookings");
    await expect(page.locator(".bk-filters__note")).toHaveText(
      "Day totals and the export cover bookings from every source.",
    );
    await expect(page.locator(".bk-row__source")).toHaveCount(0);
    const tripPicker = page.getByRole("combobox", { name: "Trip" });
    const firstTrip = await tripPicker.locator("option").nth(1).getAttribute("value");
    await tripPicker.selectOption(firstTrip ?? "");
    await dayLoaded(page);
    await expect(
      page.getByRole("heading", { level: 4, name: "No staff bookings on this trip" }),
    ).toBeVisible();
    expect(params(page)).toMatchObject({ trip: firstTrip, source: "staff_assisted" });

    // 3. A reload opens the same list; Next keeps the source and drops the trip.
    await page.reload();
    await dayLoaded(page);
    await expect(source).toHaveValue("staff_assisted");
    await expect(tripPicker).toHaveValue(firstTrip ?? "");
    await page.getByRole("button", { name: "Show all sources" }).click();
    await dayLoaded(page);
    await expect.poll(() => params(page).source).toBeUndefined();
    await source.selectOption("staff_assisted");
    await expect.poll(() => params(page).source).toBe("staff_assisted");
    await page.getByRole("button", { name: "Next day" }).click();
    await dayLoaded(page);
    expect(params(page).source).toBe("staff_assisted");
    expect(params(page).trip).toBeUndefined();
    expect(params(page).day).not.toBe(day);

    // 5 (1280 only). Any staff booking in the next two weeks: its badge sits under its reference.
    if (info.project.name === "desktop") {
      let row = page.locator(".bk-row", { has: page.locator(".bk-row__source") }).first();
      for (let i = 0; i < 14 && (await row.count()) === 0; i++) {
        await page.getByRole("button", { name: "Next day" }).click();
        await dayLoaded(page);
        row = page.locator(".bk-row", { has: page.locator(".bk-row__source") }).first();
      }
      if ((await row.count()) > 0) {
        const ref = await row.locator(".bk-row__ref").boundingBox();
        const badge = await row.locator(".bk-row__source").boundingBox();
        const facts = await row.locator(".bk-row__facts").boundingBox();
        expect(ref && badge && facts, "the row's parts are laid out").toBeTruthy();
        if (ref && badge && facts) {
          expect(badge.y).toBeGreaterThanOrEqual(ref.y + ref.height - 1);
          expect(badge.x + badge.width).toBeLessThanOrEqual(facts.x + 1);
        }
      } else {
        info.annotations.push({ type: "note", description: "no staff booking listed to place" });
      }
    }

    // 4. Every source again, and Book from the first trip header that offers it.
    await source.selectOption("");
    await dayLoaded(page);
    let book = page
      .locator(".bk-trip__side")
      .getByRole("link", { name: /^Book / })
      .first();
    for (let i = 0; i < 7 && (await book.count()) === 0; i++) {
      await page.getByRole("button", { name: "Next day" }).click();
      await dayLoaded(page);
      book = page
        .locator(".bk-trip__side")
        .getByRole("link", { name: /^Book / })
        .first();
    }
    await expect(book).toBeVisible();
    const box = await book.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    const href = await book.getAttribute("href");
    expect(href).toMatch(/^\/trips\/[0-9a-f-]{36}\/book$/);
    await book.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole("heading", { level: 2, name: "Who is coming" })).toBeVisible({
      timeout: 20_000,
    });

    expect(violations).toEqual([]);
  });
});
