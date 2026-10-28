import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * The staff-assisted booking journey (G2.12d), at 375 and 1280, on both
 * synthetic operators, through the console Worker and the API under their
 * real configuration, CSP included:
 *
 * 1. booking staff sign in with the local sign-in link;
 * 2. open a trip from the calendar;
 * 3. book a guest through the test payment control;
 * 4. see the booking confirmed on its detail, the roster, and the day's list,
 *    with its source and channel;
 * 5. see the day's totals and the CSV's Source column;
 * 6. and finance gets no way to book.
 *
 * Synthetic people only. The Reef's booking staff member is added by the CI
 * step that seeds the database.
 */

const operators = [
  { name: "Demo Harbor Charters", staff: "ben.desk@demo-harbor.test", staffName: "Ben Desk" },
  { name: "Demo Reef Divers", staff: "dan.desk@demo-reef.test", staffName: "Dan Desk" },
] as const;
const finance = "fay.books@demo-harbor.test";

/** CSP violations the page reports, collected from the console. */
function cspViolations(page: Page): string[] {
  const found: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) found.push(text);
  });
  return found;
}

/** A minimal RFC 4180 reader for the day's export. */
function parseCsv(withMark: string): string[][] {
  const text = withMark.replace(/^\ufeff/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  return rows;
}

async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByRole("link", { name: "Open the local sign-in link" }).click();
  // The link opens a confirmation, so a mail scanner's visit signs no one in.
  await page.getByRole("button", { name: "Continue signing in" }).click();
  await expect(page.getByRole("navigation", { name: "Console" })).toBeAttached({
    timeout: 30_000,
  });
}

/** The console's rail sits behind a menu on a phone; links are reached by address there too. */
async function go(page: Page, path: string) {
  await page.goto(path);
}

/** The first trip this week, or in the next few, that offers Book. */
/** A week's trips, loaded: real rows carry their sales state; the skeleton's do not. */
async function weekLoaded(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await page.locator(".cal-trip[data-state]").first().waitFor({ timeout: 20_000 });
  await expect(page.locator(".cal-trip--skeleton")).toHaveCount(0);
}

/** Move the calendar one week on, and wait for that week. */
async function nextWeek(page: Page) {
  const range = (await page.locator(".cal-bar__range").textContent()) ?? "";
  await page.getByRole("button", { name: /Next/ }).click();
  await expect(page.locator(".cal-bar__range")).not.toHaveText(range);
  await weekLoaded(page);
}

/**
 * A trip that offers Book and is far from its cutoff: from next week on, so a
 * departure today cannot close between the calendar and the checkout, and
 * the week's last such trip. The seeded season ends on 2027-05-31
 * (tools/seed/src/catalog.ts), so this finds nothing after mid-May 2027.
 */
async function firstBookable(page: Page) {
  await go(page, "/calendar");
  await weekLoaded(page);
  for (let week = 0; week < 6; week++) {
    await nextWeek(page);
    const book = page.getByRole("link", { name: /^Book / });
    if ((await book.count()) > 0) return book.last();
  }
  throw new Error("no bookable trip in the next six weeks");
}

for (const operator of operators) {
  test(`books a walk-up guest at ${operator.name}`, async ({ page }, info) => {
    const violations = cspViolations(page);
    const who = {
      name: `Synthetic Walkup ${info.project.name}`,
      email: `walkup.${info.project.name}.${Date.now()}@guest.example`,
    };
    await signIn(page, operator.staff);
    await expect(page.getByText(operator.name).first()).toBeVisible();

    // 2. A trip from the calendar.
    const book = await firstBookable(page);
    await book.click();
    await expect(page).toHaveURL(/\/trips\/[0-9a-f-]{36}\/book$/);
    await expect(page.getByRole("heading", { level: 2, name: "Who is coming" })).toBeVisible({
      timeout: 20_000,
    });

    // 3. The party, the guest, the review, and the test payment.
    const addOne = page.getByRole("button", { name: /^Add one / });
    if ((await addOne.count()) > 0) await addOne.first().click();
    await page.getByRole("button", { name: "Price and continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "The guest" })).toBeVisible();
    await page.getByLabel("Booker's name").fill(who.name);
    await page.getByLabel("Booker's email").fill(who.email);
    await page.getByLabel("How the guest reached you").selectOption("walk_up");
    await page.getByRole("button", { name: "Review" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Review with the guest" }),
    ).toBeVisible();
    await expect(page.locator(".nb-readback__email")).toHaveText(who.email);
    await expect(page.getByRole("table", { name: "Price in US dollars" })).toBeVisible();
    await page.getByLabel("I read the email address back to the guest").check();
    await page.getByLabel(/^I told the guest the cancellation policy/).check();
    await page.getByRole("button", { name: "Hold seats and take payment" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("This is a demo test payment")).toBeVisible();
    await page.getByRole("button", { name: "Take test payment" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Booked" })).toBeVisible({
      timeout: 30_000,
    });
    const confirmedTitle = await page
      .locator(".tg-notice--success .tg-notice__title")
      .textContent();
    const reference = /([0-9A-HJKMNP-TV-Z]{8})/.exec(confirmedTitle ?? "")?.[1];
    expect(reference, "the confirmed booking's reference").toBeTruthy();

    // 4. The booking, its roster, and the day's list.
    await page.getByRole("link", { name: "Open the booking" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Booking ${reference}` })).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    const guest = page.getByRole("region", { name: "Guest" });
    await expect(guest).toContainText("Staff booking, walk-up");
    await expect(guest).toContainText(operator.staffName);
    await page.getByRole("region", { name: "Trip" }).getByRole("link", { name: "Roster" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Roster" })).toBeVisible();
    const row = page.locator(".roster-table tbody tr", { hasText: reference ?? "" });
    await expect(row).toContainText("Staff booking, walk-up");
    await page.getByRole("link", { name: /^Bookings on / }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Bookings" })).toBeVisible();
    await expect(page.getByText(reference ?? "").first()).toBeVisible({ timeout: 20_000 });

    // 5. The day's totals and its CSV, which keeps the source apart.
    await expect(page.getByRole("heading", { name: "Day totals" })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await (await download).path();
    const [header, ...rows] = parseCsv(readFileSync(file, "utf8"));
    const at = (r: string[] | undefined, column: string) => r?.[(header ?? []).indexOf(column)];
    expect(header).toContain("Source");
    const line = rows.find((r) => at(r, "Booking reference") === reference);
    expect(at(line, "Source")).toBe("staff_assisted");

    expect(violations).toEqual([]);
  });
}

test("gives finance no way to book", async ({ page }) => {
  const violations = cspViolations(page);
  await signIn(page, finance);
  await go(page, "/calendar");
  await weekLoaded(page);
  await expect(page.getByRole("link", { name: /^Book / })).toHaveCount(0);
  // The page itself refuses, and asks nothing of the API.
  const asked: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/v1\/staff\/tenants\/[^/]+\/(trips\/[^/]+\/offer|quotes|checkouts)/.test(r.url())) {
      asked.push(r.url());
    }
  });
  await go(page, "/trips/7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a99/book");
  await expect(page.getByRole("heading", { name: "Your role can't make bookings" })).toBeVisible({
    timeout: 20_000,
  });
  expect(asked).toEqual([]);
  expect(violations).toEqual([]);
});
