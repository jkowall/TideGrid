# @tidegrid/operator-site

The operator console for the demo build: one React and Vite build on Workers Static Assets, behind Cloudflare Access on deployed environments. Every call stays same-origin under `/api`; the console Worker (`worker/index.ts`) forwards it to the API's `ConsoleGateway` entrypoint, and the API checks the session, the membership, and the role on every call. The console's own role checks only decide what to show. Pages: sign-in (G2.2), the overview, the calendar (G2.12a), the booking views (G2.12b), and search, day totals with the CSV export, and booking notes (G2.12c, below).

## Pages and addresses

| Address | Page |
|---|---|
| `/` | Overview: who is signed in and their operators |
| `/calendar?week=YYYY-MM-DD` | The week's trips on the marina's clock; owners and booking staff change sales states |
| `/bookings?day=YYYY-MM-DD&trip=<tripId>` | A day's bookings, optionally for one trip, with the day's totals, its CSV export, and quick find by booking reference |
| `/bookings/search` | Search every booking by reference, the booker's name or email, and departure dates (G2.12c) |
| `/bookings/<bookingId>` | One booking, with its internal notes |
| `/exceptions` | Payment exceptions: payments that could not become bookings |
| `/trips/<tripId>/roster` | A trip's printable roster |
| `/trips/<tripId>/book` | A staff booking for a guest on one trip: owners and booking staff (G2.12d) |

Addresses carry dates, ids, and booking references only, never a person's name or email, and page titles name the page and the operator, never a guest. A search's terms never enter the address either (see Search below). A day missing from the address is today on the marina's clock, read from the catalog's location zone as the calendar does. Today's list leaves the day out, so its address always opens today; a trip filter always carries its day, so a link to one trip's bookings still works tomorrow. The shell moves between pages in place through the History API; Back and Forward work, a new page starts at its top, and its heading takes focus. A link to the address already showing does nothing.

A person with more than one operator picks one in the rail. The console remembers the choice for the tab (`sessionStorage`) and as the last choice in any tab (`localStorage`), so a reload, or a booking or roster link opened in a new tab, shows the operator the address belongs to. It stores the operator's id and nothing else; an id that is not one of the person's operators is ignored, and blocked storage means the first operator. Choosing another operator drops the list's trip and day, so the next list starts from that marina's today and every trip.

Signing in returns to the page the person asked for (G2.12c). When the console finds someone signed out on a page other than the overview, it keeps that page's address (dates and ids only) in `localStorage` for half an hour, and uses it once, after the email sign-in link is redeemed. An address that is not a console page, or older than half an hour, is ignored. Signing out on purpose removes it, so the next person to sign in starts at the overview. Every "Sign in again" reloads the page it is on. Cloudflare Access returns to the requested page by itself on deployed consoles.

The rail shows the signed-in email in full, wrapped where it must, rather than cut short.

## Booking views (G2.12b)

The thin slice of G2.12 pulled forward on 2026-10-06, recorded in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence). The API contract is in [packages/contracts/src/bookings.ts](../../packages/contracts/src/bookings.ts) and the [checkout contract](../../packages/domain-booking/README.md#api).

- **Bookings.** A day's trips in departure order, each with its bookings: reference (to the booking), booker, party by ticket type or a charter's guests, extras, total, payment state, and booking state. Previous, Today, and Next move a day at a time, within two years of today, and a day in another year names its year; a trip filter narrows the day to one trip. Both live in the address, so a reload, a link, and Back show the same list. The filter's options name the time and the trip, so they fit a phone; the totals beside it give the counts. Changing the trip keeps the list on screen, marked busy, so the control keeps focus. A trip with nothing booked says "No bookings yet", or "No bookings" once it has left, and shown alone it has a designed empty state. A day with more than 100 bookings pages with Show more bookings. Loading, empty, error with Try again, and unreadable answers each have a designed state.
- **Quick find.** A booking reference as the guest reads it out: case, spaces, and hyphens are ignored, and O, I, and L read as 0, 1, and 1 (Crockford base32), by the same function the API uses (`@tidegrid/contracts/references`). A match opens the booking; anything else says why under the field. Focus stays in the field, so a live region also says "Finding the booking…" and then the answer (WCAG 4.1.3).
- **One booking.** The trip, when, the boat, and where to meet; the guest (for roles that may see them); the party and extras; the immutable order as a ledger with each tax's rate; the payment with its provider reference masked to its prefix and last four characters (a screen reader hears "fpay, ending in hGvm", not the bullets); any refund; and what happened when, on the marina's clock with the zone named, and the year when it is not this year.
- **Payment exceptions.** Newest first: what happened in plain words, the trip (a link to its bookings), the party, the amount, when the checkout ran out and when the payment arrived, the masked provider reference, and the refund's state. A payment that did not match its checkout says that nothing was refunded and shows what the provider reported. Owners and booking staff also see who paid, to follow up.
- **Roster.** Every booking on a trip with its reference, booker, party, extras, and payment, the guest totals by ticket type, the extras to prepare, and when and where to meet. Each party lists the names its guests have given so far on their booking page, by place, with a minor marked and how many of the party are named (lane 1, G2.11c); a notice says so, and that each person's waiver status follows in its own card (G2.15), rather than printing empty columns. It names itself a booking roster, not a passenger manifest, and says when it was read. Print roster prints it alone, black on white, under its own heading, with the table's head on every page (`@media print` in `src/bookings/bookings.css`). Every other page prints too, with paper colors and its own heading. On a phone the table scrolls inside its own region, with each booking's reference pinned at the left edge; the page never does. The region is a tab stop only while its table scrolls, so a keyboard reaches the scroll on a phone and skips the region on a desktop, where the table fits (G2.12c; `useOverflows` watches both sizes). Each booking's party is one cell (`PartyCell`): the count, the tickets or the charter, and the names.
- **Calendar.** Each trip's booked count links to that trip's bookings for its day.
- **Focus.** When a control goes away with a change (Try again once it works, Show more bookings with the last page, a trip filter whose list failed), focus moves to the page's or day's heading, or to the first booking or exception just loaded. It moves only when it went away with that control, never from where the person has moved it while the page loaded.

### Who sees what

The API decides; the console mirrors it with `canSeeGuests` and `canUseNotes` in `src/roles.ts`, only to choose what to show.

| | Owner | Booking staff | Finance |
|---|---|---|---|
| Bookings, booking detail, quick find | Yes | Yes | Yes |
| Booker's name (list) and name and email (detail) | Yes | Yes | No |
| Payment exceptions | Yes | Yes | Yes |
| Who paid, on an exception | Yes | Yes | No |
| Trip roster | Yes | Yes | No |
| Search by reference and departure dates (G2.12c) | Yes | Yes | Yes |
| Search by the booker's name or email, and see them in results | Yes | Yes | No |
| A day's totals and its CSV export | Yes | Yes | Yes |
| The export's booker name and email columns | Yes | Yes | No |
| Read a booking's notes | Yes | Yes | No |
| Add a note | Yes | Yes | No |

- **Finance sees the money, not the people.** Finance holds `payments.read` and `audit.read`, not `bookings.read`. It reads every booking's reference, party, extras, order lines, totals, payment, refund, and the exceptions, which is what reconciling sales, fees, taxes, and refunds needs. The booker's name and email are left out of the API's queries for any role without `bookings.read`, so they are absent from finance's responses, not hidden in the page.
- **No roster for finance.** The product scope calls the roster a booking-management view. It exists to run a departure: who is coming, how many, and what to prepare. Without the guests' names it would be the bookings list printed again, and finance's reconciliation work is covered by the list, the detail, and the exceptions, which carry the same money. Keeping the roster to `bookings.read` also keeps every sheet that leaves the screen on paper to the roles that manage bookings. The API answers 403 to finance; the console shows a designed explanation and makes no call.
- **The roster names the booker but prints no email.** The email is one click away on the booking, and a sheet carried to the dock has no use for it.
- **Finance searches money, not people (G2.12c).** For finance the API matches a search's text against booking references only and never joins the table that holds the booker, so no result, count, or refusal can depend on a name or an address. The console labels finance's field "Booking reference" and says why.
- **Notes are for the people who run bookings (owner decision, 2026-10-19).** Owners and booking staff read and write them; finance does neither. A note is free text that can name a guest or hold a phone number, so it follows the booker's details. The API refuses finance either way (403, no `notes.read`); the console shows finance no Notes card and asks for none, and the guest card says owners and booking staff see the notes. The form's hint says who reads a note before anyone writes one.

## Console completion (G2.12c)

The contract is in [packages/contracts/src/console.ts](../../packages/contracts/src/console.ts) and the [checkout contract](../../packages/domain-booking/README.md#console-completion-g212c).

- **Search.** `/bookings/search`, reached from the Bookings page beside quick find. One field (a name, an email, or the start of a reference, read as a guest says it) and a departure date range; either or both. Results come a page of 25 at a time with Show more bookings, in departure order, each with its reference (to the booking), when and on which trip, the booker's name and email for roles that may see them, the party, the total, and the payment and booking states. Designed states: the idle explanation, loading, no match (worded for each role), errors with Try again, and field errors that say what to fix. A field error is said in the live region too, since focus may already be in the field, and it takes away results that belong to other terms. Under the count the results say what they were found for ("Matching “maya”, departing Nov 1 to 30, 2026."), so a field edited since never seems to own them. New terms can be searched while a search is on its way: the old request is canceled and its answer never shows; the button is busy only for the terms on their way. Show more bookings says how many are shown. While the person is signed out, Search is a secondary button, so Sign in again is the one primary action. The search is a POST, so its terms never enter the address, a log line, or history. The last search per operator stays in the tab's memory (`src/search/model.ts`), so Back from a booking shows it again; a reload or a sign-out forgets it.
- **Day totals and the export.** The Bookings page shows the day's control totals above its trips: bookings, guests, gross (trip prices and extras before discounts), discounts, fees, added taxes, total charged, refunds, net, and included tax (tax already in the prices, never added to the total), with any pending refund in a note. A day with more bookings than one report holds (5,000) gets its own notice, with no Try again, on the totals and on Export CSV: TideGrid can split the export. They come from the ledger on the server, the same read as the export's total row. Export CSV fetches the day's file same-origin and hands it to the browser to save under the name the server gave it, the operator's slug and the date (`demo-harbor-bookings-2026-10-06.csv`); the outcome is announced, and says whether the file holds guests' names. The file opens in a spreadsheet as numbers, dates, and text, with its total row last (see the [checkout contract](../../packages/domain-booking/README.md#console-completion-g212c) for its columns).
- **Notes.** The last card on a booking: the newest notes first, each with its author as the operator names them and the time on the marina's clock. Owners and booking staff add one through a short form (500 characters, counted as the API counts them: code points, after trimming; line breaks kept), whose idempotency key is kept when the same note is sent again after a failure. The API's answer to an added note holds its id, author, and time but not its text, so the stored replay keeps no copy; the console shows the words it sent. Notes are never edited or removed. Finance never sees them.
- **Follow-ups from G2.12b.** The rail shows the whole email; signing in from a deep link returns to it; the roster's region is a tab stop only while it scrolls; a day in the address beyond two years opens the nearest day and says so, and a day no calendar holds (February 30, year 0000) opens today and says so; a later signed-out visit to the overview drops a page kept from an earlier one; and the calendar's trip query refuses year 0000 in the contract.

## Waivers (G2.15)

Two self-contained cards in `src/waivers/`, each loading its own data from the [waiver API](../../packages/domain-waivers/README.md#api), so a page only places them.

- **`BookingWaiversCard`** on a booking's detail, after the booking's history and before its notes, for roles that see guests. Each named person with their status as an icon and a label (Signed, Waiting for signature, Email failed, No email address, Email on hold, Not requested, No waiver needed, Booking canceled), who signs (the person, or a minor's parent or guardian), the template and version, and either when and by whom it was signed, with the guardian's relationship, or the latest email in words ("Email sent to a•••@example.test (send 2)", or "Email goes out 6:12 PM to …" when a sending limit holds it). Email on hold means the booking has an address but no working email reached it: a sending limit held it, or its email could not be built. Delivery and signature stay apart: an email that was sent says nothing about a signature. A signed waiver has its PDF, exactly as stored. A summary line counts who has signed and the places nobody is named for yet.
- **Send again.** For owners and booking staff, on a waiting waiver: a dialog asks for the reason, which the history records, and sends with an `Idempotency-Key` that a retry of the same send reuses. The card says when it can next be sent (the database's sending limits: 10 minutes between emails to one address, 5 sends per request, and caps per participant, address, booking, and operator), and explains each refusal in the dialog, which stays open; a refusal still commits anything the send had to close, such as an old address's links. After a send, "Sent again" shows under that person and the card reads again.
- **`TripWaiversCard`** on a trip's roster, after the sheet: signed of named, waiting, needing attention (no address, a failed or held email, or no request), and not named yet, then each booking's people with their status. It prints with the roster.

Who sees what: waiver status names people, so both cards need `bookings.read` (owners and booking staff), as the roster does; finance is refused by the API and the console does not place the cards. Sending again needs `waivers.manage` (owners and booking staff). Tests: `src/waivers/BookingWaivers.test.tsx`, and the API's role rules in `apps/api-worker/test-integration/waivers.integration.test.ts`.

### Canceled bookings (lane 1, G2.11c)

A guest may cancel within the booking's policy from the management page. The console reads it: a canceled booking keeps its place in the day's list with a Canceled badge beside its payment's, while the counts are of active bookings, the ones holding seats, so a trip whose bookings are all canceled says "No active bookings" above them. The booking's detail says who canceled and when, and that the seats went back on sale; a Cancellation block gives the remedy the policy applied on its side of the cutoff, the policy version and cutoff, and the refund due; the Refund block and the history follow the refund. Rosters and counts leave canceled bookings out.

## Staff-assisted booking (G2.12d)

Owners and booking staff book a guest who phoned, emailed, or walked up, from Book on a calendar trip that is on sale, not blacked out, and before its cutoff, or from New booking on a trip's roster, under the same rule (the roster read carries the trip's sales close and blackout for it). Finance sees neither, and on the page itself gets a refusal with no request. The API decides either way (`bookings.create`). The contract is [packages/contracts/src/staff-booking.ts](../../packages/contracts/src/staff-booking.ts); the narrowings behind it are in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence).

The page goes Party, Guest, Review, Payment, with the Steps component:

1. **Party.** A count per ticket type, or a charter's guests aboard, the add-ons within their limits, and one optional promotion code. The server prices it.
2. **Guest.** The booker's name, their email (required: the confirmation, the management link, and waiver requests go there), and how they reached staff.
3. **Review.** The server's quote as a ledger, the policy text with its version, and the email shown large to read back. Two checkboxes, "I read the email address back to the guest" and "I told the guest the cancellation policy (version N)", must both be checked before the seats are held.
4. **Payment.** A demo test payment: Take test payment or Decline, with the amount and the hold's end on the marina's clock. Cancel booking asks in a danger dialog and is unavailable while a payment is in flight.

Every failure names the command that failed ("The party couldn't be priced", "The seats couldn't be held", "The test payment may not have gone through", "The hold couldn't be released"), and its Try again repeats that command only: a failed cancel is never retried as a payment. The two attestations clear whenever staff leave the review or a new quote arrives, so they are always checked for the address, channel, and policy on screen. Once the provider has settled a payment whose result did not reach TideGrid, only Try again is offered, on the same request: Decline, Cancel booking, and Change details wait until it lands. After a payment that got no answer, the notice says it may not have gone through, the other outcome is unavailable, and Try again sends the same request on its own key; each outcome keeps its own key. A refusal because the payment already settled the other way stays on screen, with Try again sending that settled outcome. Cancel booking says the payment may already have gone through; once the cancel lands, the page sends the payment's own request again, which delivers a settled result (so the refund follows and shows) or is refused when nothing settled (so the outcome says nothing was charged), and the canceled outcome offers Check again while that is still unknown. A Change details that still gets no answer about an earlier hold says the seats may stay held for up to 15 minutes, and keeps the request to try again; one that learns the checkout keeps it, so a retry cancels that same checkout; one refused outright (nothing was held) goes straight on. The Steps mark Payment done only for a confirmed booking.

The outcome reads the checkout until its state is decided: booked (with the reference and a link to the booking), declined, refunded in full because the payment came after the hold ended, the hold ended, or canceled. Once the checkout has been asked for, the earlier steps are frozen and the request keeps its Idempotency-Key, so Try again after a provider timeout sends the same request. Change details cancels a held checkout first (asking again with the same key to learn it, after a timeout), then prices the party again and opens a new checkout with a new key. Each command keeps its key for the same body and takes a new one when the body changes. The address carries the trip's id only.

A booking's detail shows its Source ("Staff booking, phone", or "Online, by the guest") and, for a staff booking, who took it, to every role. The roster marks a staff booking under its booker. The day's CSV carries a `Source` column. The bookings list's source badge and its trip header link wait for the console flake fixes to land.

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

`pnpm --filter @tidegrid/operator-site test` runs the console's unit tests in jsdom against a fake API, with the viewer in Tokyo and the marinas in New York and Honolulu, so every time must stay the marina's. The fake API answers a booking's notes (none) and a day's totals (zero) unless a test says otherwise. The API's role and tenancy rules for the booking reads are covered by `apps/api-worker/test-integration/bookings-console.integration.test.ts`, and for search, the day's totals and export, and notes by `apps/api-worker/test-integration/console-completion.integration.test.ts`.

### Browser checks (G2.12d)

`pnpm --filter @tidegrid/operator-site e2e` runs the staff-assisted booking journey in Playwright at 375 and 1280, on both synthetic operators, against the built `dist/` under the console Worker (`wrangler dev --env dev` on port 5382, so `public/_headers` and its CSP apply), bound to the API's ConsoleGateway (`wrangler dev --env dev` on port 8981, `STAFF_ORIGINS=http://localhost:5382`). CI's `console-browser` job seeds a disposable PostgreSQL 17, adds a booking staff member at Demo Reef, and starts the API. Outside CI it uses an installed Google Chrome (`E2E_CHANNEL=chrome`); never run `playwright install` on the owner's machine.

## Not yet

- Resolving an exception (marking it followed up), cancellation, refunds, and edits belong to later G2.9, G2.11, and G2.12 work; apart from notes, every view here is read-only.
- Equipment on the roster arrives with the staged modules.
- Staff booking covers staff-assisted bookings paid through the test payment (G2.12d). Cash, check, and complimentary bookings, overrides, staff cancellation of a confirmed booking, and filtering by source are later work.
