import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingDayQuery,
  BookingDayTotalsResponse,
  BookingNoteCreateRequest,
  BookingNoteResponse,
  BookingNotesResponse,
  BookingParams,
  BookingSearchRequest,
  BookingSearchResponse,
  IdempotencyKey,
  StaffTenantParams,
} from "@tidegrid/contracts";
import { recordAudit } from "@tidegrid/database";
import {
  addBookingNote,
  buildDayReport,
  type DayReportOutcome,
  dayExportFileName,
  listBookingNotes,
  renderDayExport,
  searchBookings,
} from "@tidegrid/domain-booking";
import { can } from "@tidegrid/domain-identity";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { type StaffTenantContext, withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const searchPath = "/v1/staff/tenants/{tenantId}/booking-searches";
const totalsPath = "/v1/staff/tenants/{tenantId}/booking-day-totals";
const exportPath = "/v1/staff/tenants/{tenantId}/booking-day-export";
const notesPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/notes";

const idempotencyHeader = z.object({ "idempotency-key": IdempotencyKey });

const bookingNotFound = () =>
  new ApiError(404, "booking_not_found", "No such booking for this tenant");
const cursorInvalid = () =>
  new ApiError(400, "cursor_invalid", "The cursor names nothing this search finds");
const dayTooLarge = () =>
  new ApiError(
    422,
    "day_too_large",
    "This day has more bookings than one export holds; ask TideGrid for a split export",
  );

/**
 * Whether this request's role may see, and search on, the booker's name and
 * email. The permission that admits a route is checked first, by
 * withStaffTenant; this decides only what a read selects and matches.
 */
const seesBooker = (ctx: StaffTenantContext) => can(ctx.access.role, "bookings.read");

function report(outcome: DayReportOutcome) {
  if (outcome.kind === "too_large") throw dayTooLarge();
  return outcome.report;
}

/**
 * Console completion (G2.12c): booking search, a day's control totals, the
 * day's CSV export, and internal booking notes. Every answer carries
 * personal data or money, so no cache keeps any, refusals included.
 */
const noStorePaths = [
  "/v1/staff/tenants/:tenantId/booking-searches",
  "/v1/staff/tenants/:tenantId/booking-day-totals",
  "/v1/staff/tenants/:tenantId/booking-day-export",
  "/v1/staff/tenants/:tenantId/bookings/:bookingId/notes",
];

export function registerConsoleStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  for (const path of noStorePaths) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  // Search ------------------------------------------------------------------------

  const searchRoute = createRoute({
    method: "post",
    path: searchPath,
    tags: ["staff", "bookings"],
    summary: "Search bookings",
    description:
      "Every role. Bookings across every day by reference, by the booker's name or email, and by departure dates, a page at a time, with how many match. Owners and booking staff match on, and receive, the booker's name and email; for finance the text matches booking references only and no booker is sent. A POST, so the terms never enter a URL.",
    security: staffSecurity,
    request: {
      params: StaffTenantParams,
      body: { required: true, content: { "application/json": { schema: BookingSearchRequest } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: BookingSearchResponse } },
        description: "The bookings found",
      },
      400: errorBody(
        "A malformed search (validation_failed), from after to (invalid_range), or a cursor this search does not find (cursor_invalid)",
      ),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant"),
    },
  });

  app.openapi(searchRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const input = c.req.valid("json");
    if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
      throw new ApiError(400, "invalid_range", "The first date is after the last");
    }
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read", snapshot: true },
      async (trx, ctx) => {
        const found = await searchBookings(trx, tenantId, {
          ...(input.q === undefined ? {} : { q: input.q }),
          ...(input.from === undefined ? {} : { from: input.from }),
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.after === undefined ? {} : { after: input.after }),
          limit: input.limit,
          withBooker: seesBooker(ctx),
        });
        if (found.kind === "cursor_invalid") throw cursorInvalid();
        return {
          results: found.results.map((r) => ({ ...r })),
          total: found.total,
          nextAfter: found.nextAfter,
          matchedOn: found.matchedOn,
        };
      },
    );
    return c.json(body, 200);
  });

  // A day's totals ------------------------------------------------------------------

  const totalsRoute = createRoute({
    method: "get",
    path: totalsPath,
    tags: ["staff", "bookings"],
    summary: "A day's control totals",
    description:
      "Every role. The bookings on trips departing on one local date, totaled from the ledger: bookings, guests, gross, discounts, fees, taxes, the total charged, succeeded refunds, and net, with included taxes and pending refunds beside them. The day's CSV export ends with the same figures.",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: BookingDayQuery },
    responses: {
      200: {
        content: { "application/json": { schema: BookingDayTotalsResponse } },
        description: "The day's totals",
      },
      400: errorBody("A malformed date (validation_failed)"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
      422: errorBody("More bookings on the day than one report holds (day_too_large)"),
    },
  });

  app.openapi(totalsRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { date } = c.req.valid("query");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read", snapshot: true },
      async (trx) => {
        const day = report(await buildDayReport(trx, tenantId, { date, withBooker: false }));
        return {
          date: day.date,
          generatedAt: day.generatedAt,
          currency: "USD" as const,
          totals: { ...day.totals, pendingRefunds: { ...day.totals.pendingRefunds } },
        };
      },
    );
    return c.json(body, 200);
  });

  // The day's CSV export ---------------------------------------------------------------

  const exportRoute = createRoute({
    method: "get",
    path: exportPath,
    tags: ["staff", "bookings"],
    summary: "Export a day's bookings as CSV",
    description:
      "Every role. One row per booking on trips departing on one local date, with its ledger, then a total row equal to the day's control totals. Stable columns; owners and booking staff also get the booker's name and email, and finance gets the financial columns only. UTF-8 with a byte order mark and CRLF lines; text a person typed is kept from running as a spreadsheet formula. The file name holds the operator's slug and the date only. Each export is recorded in the audit history.",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: BookingDayQuery },
    responses: {
      200: {
        content: { "text/csv": { schema: z.string() } },
        description: "The day's bookings as an attachment",
      },
      400: errorBody("A malformed date (validation_failed)"),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
      422: errorBody("More bookings on the day than one export holds (day_too_large)"),
    },
  });

  app.openapi(exportRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { date } = c.req.valid("query");
    // One statement reads the rows, so they are one moment; the audit row
    // commits with the read, before anything leaves.
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read" },
      async (trx, ctx) => {
        const withBooker = seesBooker(ctx);
        const day = report(await buildDayReport(trx, tenantId, { date, withBooker }));
        await recordAudit(trx, ctx, {
          action: "booking_day.exported",
          subjectType: "booking_day",
          subjectId: date,
          after: { rows: day.rows.length, withGuestDetails: withBooker },
        });
        return {
          csv: renderDayExport(day, { name: ctx.access.tenant.name }, { withBooker }),
          fileName: dayExportFileName(ctx.access.tenant.slug, date),
        };
      },
    );
    return c.body(body.csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${body.fileName}"`,
      "X-Content-Type-Options": "nosniff",
    });
  });

  // Notes --------------------------------------------------------------------------------

  const listNotesRoute = createRoute({
    method: "get",
    path: notesPath,
    tags: ["staff", "bookings"],
    summary: "A booking's internal notes",
    description:
      "Every role. The newest 200 notes, newest first, each with its author as this operator names them and when it was written, and how many there are. An unknown id and another tenant's id answer the same 404.",
    security: staffSecurity,
    request: { params: BookingParams },
    responses: {
      200: {
        content: { "application/json": { schema: BookingNotesResponse } },
        description: "The notes",
      },
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant, or no such booking for it (booking_not_found)"),
    },
  });

  app.openapi(listNotesRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "notes.read", snapshot: true },
      async (trx) => {
        const found = await listBookingNotes(trx, tenantId, bookingId);
        if (!found) throw bookingNotFound();
        return {
          notes: found.notes.map((n) => ({ ...n, author: { ...n.author } })),
          total: found.total,
        };
      },
    );
    return c.json(body, 200);
  });

  const addNoteRoute = createRoute({
    method: "post",
    path: notesPath,
    tags: ["staff", "bookings"],
    summary: "Add an internal note to a booking",
    description:
      "Owners and booking staff. Append-only: a note is never edited or removed. The author is the signed-in staff member and the time is the database's. Recorded in the audit history by the note's id; the text itself never enters the audit history. Idempotent by key.",
    security: staffSecurity,
    request: {
      params: BookingParams,
      headers: idempotencyHeader,
      body: {
        required: true,
        content: { "application/json": { schema: BookingNoteCreateRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: BookingNoteResponse } },
        description: "The note",
      },
      400: errorBody("Invalid request"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant, or no such booking for it (booking_not_found)"),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(addNoteRoute, async (c) => {
    const { tenantId, bookingId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "notes.write",
        idempotency: {
          scope: "bookings.notes.add",
          key,
          route: notesPath,
          params: { bookingId },
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const added = await addBookingNote(trx, ctx, { bookingId, body: input.body });
        if (added.kind === "booking_not_found") throw bookingNotFound();
        return { note: { ...added.note, author: { ...added.note.author } } };
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    if (result.status !== 201) throw new Error(`unexpected stored status ${result.status}`);
    return c.json(result.body, 201);
  });
}
