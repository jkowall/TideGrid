# @tidegrid/operator-site

The operator console for the demo build: one React and Vite build on Workers Static Assets, behind Cloudflare Access on deployed environments. Every call stays same-origin under `/api`; the console Worker (`worker/index.ts`) forwards it to the API's `ConsoleGateway` entrypoint, and the API checks the session, the membership, and the role on every call. The console's own role checks only decide what to show. Pages: sign-in (G2.2), the overview, the calendar (G2.12a), and the booking views (G2.12b, below).

## Pages and addresses

| Address | Page |
|---|---|
| `/` | Overview: who is signed in and their operators |
| `/calendar?week=YYYY-MM-DD` | The week's trips on the marina's clock; owners and booking staff change sales states |
| `/bookings?day=YYYY-MM-DD&trip=<tripId>` | A day's bookings, optionally for one trip, with quick find by booking reference |
| `/bookings/<bookingId>` | One booking |
| `/exceptions` | Payment exceptions: payments that could not become bookings |
| `/trips/<tripId>/roster` | A trip's printable roster |

Addresses carry dates, ids, and booking references only, never a person's name or email, and page titles name the page and the operator, never a guest. A day missing from the address is today on the marina's clock, read from the catalog's location zone as the calendar does. Today's list leaves the day out, so its address always opens today; a trip filter always carries its day, so a link to one trip's bookings still works tomorrow. The shell moves between pages in place through the History API; Back and Forward work, a new page starts at its top, and its heading takes focus. A link to the address already showing does nothing.

A person with more than one operator picks one in the rail. The console remembers the choice for the tab (`sessionStorage`) and as the last choice in any tab (`localStorage`), so a reload, or a booking or roster link opened in a new tab, shows the operator the address belongs to. It stores the operator's id and nothing else; an id that is not one of the person's operators is ignored, and blocked storage means the first operator. Choosing another operator drops the list's trip and day, so the next list starts from that marina's today and every trip.

## Booking views (G2.12b)

The thin slice of G2.12 pulled forward on 2026-10-06, recorded in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence). The API contract is in [packages/contracts/src/bookings.ts](../../packages/contracts/src/bookings.ts) and the [checkout contract](../../packages/domain-booking/README.md#api).

- **Bookings.** A day's trips in departure order, each with its bookings: reference (to the booking), booker, party by ticket type or a charter's guests, extras, total, payment state, and booking state. Previous, Today, and Next move a day at a time, within two years of today, and a day in another year names its year; a trip filter narrows the day to one trip. Both live in the address, so a reload, a link, and Back show the same list. The filter's options name the time and the trip, so they fit a phone; the totals beside it give the counts. Changing the trip keeps the list on screen, marked busy, so the control keeps focus. A trip with nothing booked says "No bookings yet", or "No bookings" once it has left, and shown alone it has a designed empty state. A day with more than 100 bookings pages with Show more bookings. Loading, empty, error with Try again, and unreadable answers each have a designed state.
- **Quick find.** A booking reference as the guest reads it out: case, spaces, and hyphens are ignored, and O, I, and L read as 0, 1, and 1 (Crockford base32), by the same function the API uses (`@tidegrid/contracts/references`). A match opens the booking; anything else says why under the field. Focus stays in the field, so a live region also says "Finding the booking…" and then the answer (WCAG 4.1.3).
- **One booking.** The trip, when, the boat, and where to meet; the guest (for roles that may see them); the party and extras; the immutable order as a ledger with each tax's rate; the payment with its provider reference masked to its prefix and last four characters (a screen reader hears "fpay, ending in hGvm", not the bullets); any refund; and what happened when, on the marina's clock with the zone named, and the year when it is not this year.
- **Payment exceptions.** Newest first: what happened in plain words, the trip (a link to its bookings), the party, the amount, when the checkout ran out and when the payment arrived, the masked provider reference, and the refund's state. A payment that did not match its checkout says that nothing was refunded and shows what the provider reported. Owners and booking staff also see who paid, to follow up.
- **Roster.** Every booking on a trip with its reference, booker, party, extras, and payment, the guest totals by ticket type, the extras to prepare, and when and where to meet. Participants and waivers are not collected yet, and the roster says so in a notice rather than printing empty columns. It names itself a booking roster, not a passenger manifest, and says when it was read. Print roster prints it alone, black on white, under its own heading, with the table's head on every page (`@media print` in `src/bookings/bookings.css`). Every other page prints too, with paper colors and its own heading. On a phone the table scrolls inside its own region, with each booking's reference pinned at the left edge; the page never does.
- **Calendar.** Each trip's booked count links to that trip's bookings for its day.
- **Focus.** When a control goes away with a change (Try again once it works, Show more bookings with the last page, a trip filter whose list failed), focus moves to the page's or day's heading, or to the first booking or exception just loaded. It moves only when it went away with that control, never from where the person has moved it while the page loaded.

### Who sees what

The API decides; the console mirrors it with `canSeeGuests` in `src/roles.ts`, only to choose what to show.

| | Owner | Booking staff | Finance |
|---|---|---|---|
| Bookings, booking detail, quick find | Yes | Yes | Yes |
| Booker's name (list) and name and email (detail) | Yes | Yes | No |
| Payment exceptions | Yes | Yes | Yes |
| Who paid, on an exception | Yes | Yes | No |
| Trip roster | Yes | Yes | No |

- **Finance sees the money, not the people.** Finance holds `payments.read` and `audit.read`, not `bookings.read`. It reads every booking's reference, party, extras, order lines, totals, payment, refund, and the exceptions, which is what reconciling sales, fees, taxes, and refunds needs. The booker's name and email are left out of the API's queries for any role without `bookings.read`, so they are absent from finance's responses, not hidden in the page.
- **No roster for finance.** The product scope calls the roster a booking-management view. It exists to run a departure: who is coming, how many, and what to prepare. Without the guests' names it would be the bookings list printed again, and finance's reconciliation work is covered by the list, the detail, and the exceptions, which carry the same money. Keeping the roster to `bookings.read` also keeps every sheet that leaves the screen on paper to the roles that manage bookings. The API answers 403 to finance; the console shows a designed explanation and makes no call.
- **The roster names the booker but prints no email.** The email is one click away on the booking, and a sheet carried to the dock has no use for it.

## Content security policy

`public/_headers` keeps `style-src 'self'` with no inline styles: React and the design system set styles only through the CSSOM, and print styles live in the stylesheet. `src/static.test.ts` holds this. The console bundles no schema code: it imports only types from `@tidegrid/contracts`, and the reference normalizer from the dependency-free `@tidegrid/contracts/references`.

## Demo data

The seed creates trips but no bookings. With `SEED_DEMO_BOOKINGS=1`, `pnpm db:seed` also books each demo operator's earliest bookable departure twice (one booking with extras, one with the promotion code), a private charter, and a late payment that could not be honored, refunded in full, with its exception. Every booking goes through the real checkout and a verified fake-provider event, never a direct insert, and a second run changes nothing. It takes about a minute the first time, because the late payment's checkout must run out first. See `tools/seed/src/bookings.ts`.

## Local development

```sh
pnpm --filter @tidegrid/api-worker dev        # the API on :8787 (needs apps/api-worker/.dev.vars)
pnpm --filter @tidegrid/operator-site dev     # the console on :5174, /api forwarded to :8787
```

`CONSOLE_DEV_PORT` and `API_DEV_ORIGIN` move either port. Sign in with a seeded synthetic address: `ava.owner@demo-harbor.test` (owner), `ben.desk@demo-harbor.test` (booking staff), `fay.books@demo-harbor.test` (finance), or `cara.owner@demo-reef.test` (Demo Reef owner). Local sign-in shows its link on screen; deployed consoles use Cloudflare Access.

## Tests

`pnpm --filter @tidegrid/operator-site test` runs the console's unit tests in jsdom against a fake API, with the viewer in Tokyo and the marinas in New York and Honolulu, so every time must stay the marina's. The API's role and tenancy rules for the booking reads are covered by `apps/api-worker/test-integration/bookings-console.integration.test.ts`.

## Not yet

- Resolving an exception (marking it followed up), cancellation, refunds, and edits belong to later G2.9, G2.11, and G2.12 work; every view here is read-only.
- Search across days by guest name, CSV exports with control totals, participants, waivers, and equipment on the roster arrive with G2.12, G2.15, and the staged modules.
