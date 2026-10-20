import { z } from "zod";
import { BookingPaymentStatus, BookingReference } from "./bookings.ts";
import { TripSummary } from "./catalog.ts";

/**
 * Console completion (G2.12c): booking search, a day's control totals and its
 * CSV export, and internal booking notes.
 *
 * Who sees what follows the console booking views (bookings.ts):
 * - Every role that holds `payments.read` (owners, booking staff, and
 *   finance) searches bookings, reads a day's totals, and exports the day.
 * - The booker's name and email are personal data. Only roles that also hold
 *   `bookings.read` (owners and booking staff) receive them, and only their
 *   searches match on them. For finance a search matches booking references
 *   only, the `booker` field is absent, and the export carries financial
 *   columns only.
 * - Owners and booking staff read and write a booking's notes (`notes.read`,
 *   `notes.write`). Finance holds neither: a note is free text that can
 *   mention a guest (the owner's decision of 2026-10-19).
 *
 * Search terms can be names and email addresses, so a search is a POST with a
 * JSON body: the terms never enter a URL, a log line, or browser history.
 * Money is integer US cents.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const Cents = z.number().int().describe("Integer US cents");
/** A local date PostgreSQL can hold. The ISO calendar has a year 0000; PostgreSQL's dates do not. */
const QueryDate = z.iso
  .date()
  .refine((value) => !value.startsWith("0000-"), "There is no year 0")
  .describe("Local calendar date at the marina, YYYY-MM-DD");
const LocalDate = z.iso.date().describe("Local calendar date at the marina, YYYY-MM-DD");

const BookerContact = z
  .object({ name: z.string(), email: z.string() })
  .optional()
  .describe(
    "Personal data. Present only for roles that hold bookings.read (owners and booking staff); absent otherwise",
  );

// Search ----------------------------------------------------------------------------

/** What a search's text was matched against, which depends on the role. */
export const BookingSearchField = z.enum(["reference", "booker_name", "booker_email"]);
export type BookingSearchField = z.infer<typeof BookingSearchField>;

export const BookingSearchRequest = z
  .object({
    q: z
      .string()
      .trim()
      .min(2)
      .max(120)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
      .regex(/^[^\u0000-\u001f\u007f]*$/, "Control characters are not allowed")
      .optional()
      .describe(
        "Text to find. It matches a booking reference from its start, read the way a guest quotes it (case, spaces, and hyphens ignored; O, I, and L as 0, 1, and 1). For roles that hold bookings.read it also matches the booker's name, when every word appears in it, and part of the booker's email, ignoring case. For any other role it matches references only",
      ),
    from: QueryDate.optional().describe(
      "First departure date at the marina, inclusive. Bookings are found by their trip's local date",
    ),
    to: QueryDate.optional().describe("Last departure date at the marina, inclusive"),
    limit: z.number().int().min(1).max(100).default(25),
    after: Uuid.optional().describe(
      "Cursor: the last booking id of the previous page (nextAfter). One that names no booking this search finds answers 400 cursor_invalid",
    ),
  })
  .refine((r) => r.q !== undefined || r.from !== undefined || r.to !== undefined, {
    message: "Give text to find, a date, or both",
  })
  .describe("A booking search. At least one of q, from, and to");
export type BookingSearchRequest = z.input<typeof BookingSearchRequest>;

export const BookingSearchResult = z.object({
  id: Uuid,
  reference: BookingReference,
  state: z.literal("confirmed"),
  confirmedAt: Instant,
  trip: TripSummary,
  booker: BookerContact,
  guests: z.number().int().min(1).describe("The party's size"),
  total: Cents.describe("The order's total"),
  currency: z.literal("USD"),
  payment: BookingPaymentStatus,
});
export type BookingSearchResult = z.infer<typeof BookingSearchResult>;

export const BookingSearchResponse = z
  .object({
    results: z
      .array(BookingSearchResult)
      .describe("This page, by departure, then trip, then confirmation"),
    total: z.number().int().min(0).describe("Bookings found across every page"),
    nextAfter: Uuid.nullable().describe("Pass as after for the next page; null on the last page"),
    matchedOn: z
      .array(BookingSearchField)
      .describe(
        "What q was matched against for this role: every field for owners and booking staff, the reference only for finance. Empty when there is no q",
      ),
  })
  .describe("Bookings that match a search, a page at a time");
export type BookingSearchResponse = z.infer<typeof BookingSearchResponse>;

// A day's totals and export -----------------------------------------------------------

export const BookingDayQuery = z.object({
  date: QueryDate.describe(
    "The marina's local date: the bookings on trips departing that day, as on the bookings list",
  ),
});
export type BookingDayQuery = z.infer<typeof BookingDayQuery>;

export const BookingDayTotals = z
  .object({
    bookings: z.number().int().min(0).describe("Bookings on the day's trips"),
    guests: z.number().int().min(0).describe("Guests across those bookings"),
    gross: Cents.describe("Trip prices and paid extras, before discounts: the orders' subtotals"),
    discounts: Cents.describe("Promotion discounts, as a positive amount"),
    fees: Cents.describe("Mandatory fees"),
    taxes: Cents.describe("Taxes added on top of prices"),
    total: Cents.describe("What the guests were charged: gross - discounts + fees + taxes"),
    refunds: Cents.describe("Refunds that succeeded, as a positive amount"),
    net: Cents.describe("total - refunds"),
    includedTax: Cents.describe("Taxes already inside prices, and so inside gross; informational"),
    pendingRefunds: z
      .object({ count: z.number().int().min(0), amount: Cents })
      .describe("Refunds requested and not yet settled. Not in refunds or net until they succeed"),
  })
  .describe(
    "Control totals that reconcile to the ledger: each booking's immutable order and its payment's refunds",
  );
export type BookingDayTotals = z.infer<typeof BookingDayTotals>;

export const BookingDayTotalsResponse = z.object({
  date: LocalDate,
  generatedAt: Instant.describe("When the totals were read"),
  currency: z.literal("USD"),
  totals: BookingDayTotals,
});
export type BookingDayTotalsResponse = z.infer<typeof BookingDayTotalsResponse>;

/**
 * The day's CSV export, column by column. Stable: a role that may see guests
 * gets the two booker columns after these, and no role gets any other.
 */
export const bookingDayExportColumns = [
  "Row",
  "Operator",
  "Departure date",
  "Departure time",
  "Time zone",
  "Departure at (UTC)",
  "Trip",
  "Boat",
  "Booking reference",
  "Booking state",
  "Payment state",
  "Refund state",
  "Bookings",
  "Guests",
  "Gross",
  "Discounts",
  "Fees",
  "Added taxes",
  "Total",
  "Refunds",
  "Pending refunds",
  "Net",
  "Included tax",
  "Currency",
  "Confirmed at (UTC)",
  "Generated at (UTC)",
] as const;

/** The columns only roles that hold bookings.read receive, after the rest. */
export const bookingDayExportGuestColumns = ["Booker name", "Booker email"] as const;

// Notes ---------------------------------------------------------------------------------

/**
 * Characters that show nothing: white space, C0 and C1 controls, and the
 * Unicode spaces, joiners, marks, fillers, and variation selectors. A note
 * holds at least one character outside them. Migration 0008's CHECK uses the
 * same set.
 */
export const invisibleCharacters =
  "\\s\\u0000-\\u001f\\u007f-\\u009f\\u00a0\\u00ad\\u115f\\u1160\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2064\\u206a-\\u206f\\u3000\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0";
const visibleCharacter = new RegExp(`[^${invisibleCharacters}]`, "u");

export const BookingNoteBody = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
    /^[^\u0000-\u0009\u000b-\u001f\u007f-\u009f]*$/,
    "Only line breaks are allowed as control characters",
  )
  .regex(visibleCharacter, "A note holds at least one visible character")
  .describe(
    "Up to 500 characters (code points, after trimming), with at least one visible one. Line breaks are kept; other control characters are refused",
  );

export const BookingNoteCreateRequest = z.object({ body: BookingNoteBody });
export type BookingNoteCreateRequest = z.infer<typeof BookingNoteCreateRequest>;

export const BookingNote = z
  .object({
    id: Uuid,
    body: z.string(),
    author: z
      .object({
        userId: Uuid,
        name: z.string().describe("How this operator names the staff member"),
      })
      .describe("Who wrote it: the signed-in staff member, never a value the request named"),
    createdAt: Instant.describe("When it was written, on the database's clock"),
  })
  .describe("An internal note on a booking. Append-only: never edited or removed");
export type BookingNote = z.infer<typeof BookingNote>;

export const BookingNotesResponse = z.object({
  notes: z.array(BookingNote).describe("Newest first; at most 200"),
  total: z.number().int().min(0).describe("Every note on the booking"),
});
export type BookingNotesResponse = z.infer<typeof BookingNotesResponse>;

/**
 * What adding a note answers: the note without its text. The answer is kept
 * for replaying the idempotency key, so the text, which can mention a guest,
 * is never copied there. The writer already holds the text it sent.
 */
export const BookingNoteCreated = BookingNote.omit({ body: true }).describe(
  "The note just written, without its text: the writer sent it",
);
export type BookingNoteCreated = z.infer<typeof BookingNoteCreated>;

export const BookingNoteCreatedResponse = z.object({ note: BookingNoteCreated });
export type BookingNoteCreatedResponse = z.infer<typeof BookingNoteCreatedResponse>;
