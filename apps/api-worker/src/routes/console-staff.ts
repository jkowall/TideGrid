import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BookingDayQuery,
  BookingDayTotalsResponse,
  BookingNoteCreatedResponse,
  BookingNoteCreateRequest,
  BookingNotesResponse,
  BookingParams,
  BookingSearchRequest,
  BookingSearchResponse,
  FinalizationExceptionParams,
  FinalizationExceptionResolvedResponse,
  FinalizationExceptionResolveRequest,
  IdempotencyKey,
  MoneyReportQuery,
  MoneyReportResponse,
  StaffTenantParams,
} from "@tidegrid/contracts";
import { recordAudit } from "@tidegrid/database";
import {
  addBookingNote,
  buildDayReport,
  buildMoneyReport,
  type DayReportOutcome,
  dayExportFileName,
  listBookingNotes,
  type MoneyReportOutcome,
  moneyExportFileName,
  renderDayExport,
  renderMoneyExport,
  resolveFinalizationException,
  searchBookings,
} from "@tidegrid/domain-booking";
import { type AccessRole, can } from "@tidegrid/domain-identity";
import type { AppDeps, AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { type StaffTenantContext, withStaffTenant } from "../staff-tenant.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const searchPath = "/v1/staff/tenants/{tenantId}/booking-searches";
const totalsPath = "/v1/staff/tenants/{tenantId}/booking-day-totals";
const exportPath = "/v1/staff/tenants/{tenantId}/booking-day-export";
const moneyReportPath = "/v1/staff/tenants/{tenantId}/money-report";
const moneyExportPath = "/v1/staff/tenants/{tenantId}/money-export";
const notesPath = "/v1/staff/tenants/{tenantId}/bookings/{bookingId}/notes";
const resolutionPath =
  "/v1/staff/tenants/{tenantId}/finalization-exceptions/{exceptionId}/resolution";

const idempotencyHeader = z.object({ "idempotency-key": IdempotencyKey });

const bookingNotFound = () =>
  new ApiError(404, "booking_not_found", "No such booking for this tenant");
const exceptionNotFound = () =>
  new ApiError(404, "exception_not_found", "No such payment exception for this tenant");
const cursorInvalid = () =>
  new ApiError(400, "cursor_invalid", "The cursor names nothing this search finds");
const dayTooLarge = () =>
  new ApiError(
    422,
    "day_too_large",
    "This day has more bookings than one export holds; ask TideGrid for a split export",
  );

const rangeInvalid = () =>
  new ApiError(
    400,
    "invalid_range",
    "The first date is after the last, or the range is longer than 92 days",
  );
const rangeTooLarge = () =>
  new ApiError(
    422,
    "range_too_large",
    "This range has more entries than one report holds; choose a shorter range",
  );

/**
 * What a money report shows this role (W3-G2.12-rest, D3): a check or receipt
 * number staff typed can name a guest, so only the operator's own staff who
 * see guests (owners and booking staff) read it. Finance and TideGrid support,
 * even under a grant that reveals personal data, get the cell blank. Support
 * sees provider ids masked, as on the booking detail.
 */
export function moneyViewFor(role: AccessRole) {
  const support = role.startsWith("support");
  return {
    typedReferences: !support && can(role, "bookings.read"),
    maskProviderReferences: support,
  };
}
const moneyView = (ctx: StaffTenantContext) => moneyViewFor(ctx.access.role);

function moneyReport(outcome: MoneyReportOutcome) {
  if (outcome.kind === "invalid_range") throw rangeInvalid();
  if (outcome.kind === "too_large") throw rangeTooLarge();
  return outcome.report;
}

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
 * day's CSV export, and internal booking notes. W1-FIN-EXC adds resolving a
 * payment exception. Every answer carries
 * personal data or money, so no cache keeps any, refusals included: app.ts
 * marks every staff answer no-store, before the guards run.
 */
export function registerConsoleStaffRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  // A test may lower the day report's limit to reach day_too_large.
  const limit = deps.dayReportLimit === undefined ? {} : { limit: deps.dayReportLimit };
  const moneyLimit = deps.moneyReportLimit === undefined ? {} : { limit: deps.moneyReportLimit };

  // Search ------------------------------------------------------------------------

  const searchRoute = createRoute({
    method: "post",
    path: searchPath,
    tags: ["staff", "bookings"],
    summary: "Search bookings",
    description:
      "Every role. Bookings across every day by reference, by the booker's name or email, by departure dates, and optionally narrowed to one booking source, a page at a time, with how many match. Owners and booking staff match on, and receive, the booker's name and email; for finance the text matches booking references only and no booker is sent. A POST, so the terms never enter a URL.",
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
        "A malformed search or source (validation_failed), from after to (invalid_range), or a cursor this search does not find (cursor_invalid)",
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
          ...(input.source === undefined ? {} : { source: input.source }),
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
          source: input.source ?? null,
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
        const day = report(
          await buildDayReport(trx, tenantId, { date, withBooker: false, ...limit }),
        );
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
      "Every role. One row per booking on trips departing on one local date, with its ledger, then a total row equal to the day's control totals. Stable columns; owners and booking staff also get the booker's name and email, and finance gets the financial columns only. UTF-8 with a byte order mark and CRLF lines; text a person typed is kept from running as a spreadsheet formula, and a booking reference a spreadsheet would read as a number starts with an apostrophe. The file name holds the operator's slug and the date only. Each export is recorded in the audit history.",
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
        const day = report(await buildDayReport(trx, tenantId, { date, withBooker, ...limit }));
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

  // Money movements for a date range (W3-G2.12-rest) ------------------------------------

  const moneyReportRoute = createRoute({
    method: "get",
    path: moneyReportPath,
    tags: ["staff", "bookings"],
    summary: "Money movements for a date range: control totals",
    description:
      "Every role. Every entry in the money ledgers on the operator's business dates from and to (inclusive, at most 92 days): card and balance payments that succeeded, cash, check, and other money staff recorded, card refunds that succeeded, lost disputes, booking credit entries, and TideGrid's fee and its reversals, totaled by kind. Business dates are counted in the billing plan's time zone, else the one zone all active locations share, else UTC. controlTotalsMatch is true when the entries add up to a separate count and sum of each ledger and the fee to the monthly invoice's figure, so the export is whole; it does not tie money to orders (the day export does, by trip date). No guest's name or email. The money export carries the same entries and ends with the same totals.",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: MoneyReportQuery },
    responses: {
      200: {
        content: { "application/json": { schema: MoneyReportResponse } },
        description: "The range's totals",
      },
      400: errorBody(
        "A malformed date (validation_failed), or from after to or more than 92 days (invalid_range)",
      ),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
      422: errorBody("More entries in the range than one report holds (range_too_large)"),
    },
  });

  app.openapi(moneyReportRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { from, to } = c.req.valid("query");
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read", snapshot: true },
      async (trx, ctx) => {
        const r = moneyReport(
          await buildMoneyReport(trx, tenantId, { from, to, ...moneyLimit, ...moneyView(ctx) }),
        );
        return {
          from: r.from,
          to: r.to,
          timeZone: r.timeZone,
          generatedAt: r.generatedAt,
          currency: "USD" as const,
          totals: { ...r.totals },
          byKind: r.byKind.map((k) => ({ ...k })),
          ledgerFeeTotal: r.ledgerFeeTotal,
          controlTotalsMatch: r.controlTotalsMatch,
        };
      },
    );
    return c.json(body, 200);
  });

  const moneyExportRoute = createRoute({
    method: "get",
    path: moneyExportPath,
    tags: ["staff", "bookings"],
    summary: "Export money movements for a date range as CSV",
    description:
      "Every role. One row per money ledger entry on the business dates from and to, as the money report counts them, with its exact moment, kind, booking reference and source, tender, the provider's or the typed reference, and its money in, money out, credit, and TideGrid fee; then a total row equal to the report's totals. Stable columns, the same for every role, with no guest's name or email. The reference is the provider's id (masked for TideGrid support), or the check or receipt number staff typed, which only owners and booking staff receive because it can name a guest. Operator, range, time zone, and generation time are on every row. UTF-8 with a byte order mark and CRLF lines; a typed reference is kept from running as a spreadsheet formula. The file name holds the operator's slug and the range only. Each export is recorded in the audit history.",
    security: staffSecurity,
    request: { params: StaffTenantParams, query: MoneyReportQuery },
    responses: {
      200: {
        content: { "text/csv": { schema: z.string() } },
        description: "The range's entries as an attachment",
      },
      400: errorBody(
        "A malformed date (validation_failed), or from after to or more than 92 days (invalid_range)",
      ),
      401: errorBody("Not signed in"),
      403: errorBody("Role does not allow this"),
      404: errorBody("No such tenant"),
      422: errorBody("More entries in the range than one export holds (range_too_large)"),
    },
  });

  app.openapi(moneyExportRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { from, to } = c.req.valid("query");
    // One statement reads the entries and the control figures, so they are
    // one moment; the audit row commits with the read, before anything leaves.
    const { body } = await withStaffTenant(
      c,
      deps,
      { tenantId, permission: "payments.read" },
      async (trx, ctx) => {
        const r = moneyReport(
          await buildMoneyReport(trx, tenantId, { from, to, ...moneyLimit, ...moneyView(ctx) }),
        );
        await recordAudit(trx, ctx, {
          action: "money_report.exported",
          subjectType: "money_report",
          subjectId: `${from}..${to}`,
          after: { rows: r.entries.length, controlTotalsMatch: r.controlTotalsMatch },
        });
        return {
          csv: renderMoneyExport(r, { name: ctx.access.tenant.name }),
          fileName: moneyExportFileName(ctx.access.tenant.slug, from, to),
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
      "Owners and booking staff; finance holds no notes.read. The newest 200 notes, newest first, each with its author as this operator names them and when it was written, and how many there are. An unknown id and another tenant's id answer the same 404.",
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
        content: { "application/json": { schema: BookingNoteCreatedResponse } },
        description: "The note, without its text",
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
        // This answer is also the one kept for replaying the key, so it names
        // the note and leaves its text, which can mention a guest, out.
        const { id, author, createdAt } = added.note;
        return { note: { id, author: { ...author }, createdAt } };
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    if (result.status !== 201) throw new Error(`unexpected stored status ${result.status}`);
    return c.json(result.body, 201);
  });

  // Exception resolution (W1-FIN-EXC) -----------------------------------------------------

  const resolveRoute = createRoute({
    method: "post",
    path: resolutionPath,
    tags: ["staff", "bookings"],
    summary: "Mark a payment exception as followed up",
    description:
      "Owners and booking staff; finance reads resolutions and resolves none. Records how staff followed the exception up: a reason code and, when they choose, a note (required for other). Once per exception, never edited or removed. It changes no money, booking, payment, or refund. Refused while the automatic refund is still requested. The resolver is the signed-in staff member and the time is the database's. Recorded in the audit history by the resolution's id and reason code; the note never enters the audit history or the answer. Idempotent by key: a replay answers the first result.",
    security: staffSecurity,
    request: {
      params: FinalizationExceptionParams,
      headers: idempotencyHeader,
      body: {
        required: true,
        content: { "application/json": { schema: FinalizationExceptionResolveRequest } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: FinalizationExceptionResolvedResponse } },
        description: "The resolution, without its note",
      },
      400: errorBody("Invalid request: an unknown reason, a bad note, or other without a note"),
      401: errorBody("Not signed in"),
      403: errorBody("Role or origin does not allow this"),
      404: errorBody("No such tenant, or no such exception for it (exception_not_found)"),
      409: errorBody(
        "Already followed up (exception_already_resolved), or the automatic refund is still in progress (exception_refund_pending)",
      ),
      422: errorBody("Idempotency key reused with a different request"),
    },
  });

  app.openapi(resolveRoute, async (c) => {
    const { tenantId, exceptionId } = c.req.valid("param");
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const result = await withStaffTenant(
      c,
      deps,
      {
        tenantId,
        permission: "exceptions.resolve",
        idempotency: {
          scope: "finalization_exceptions.resolve",
          key,
          route: resolutionPath,
          params: { exceptionId },
          body: input,
          successStatus: 201,
        },
      },
      async (trx, ctx) => {
        const resolved = await resolveFinalizationException(trx, ctx, {
          exceptionId,
          reasonCode: input.reasonCode,
          note: input.note ?? null,
        });
        if (resolved.kind === "exception_not_found") throw exceptionNotFound();
        if (resolved.kind === "already_resolved") {
          throw new ApiError(
            409,
            "exception_already_resolved",
            "This payment exception has already been followed up",
          );
        }
        if (resolved.kind === "refund_pending") {
          throw new ApiError(
            409,
            "exception_refund_pending",
            "The automatic refund is still in progress; resolve it once the refund settles",
          );
        }
        // This answer is also the one kept for replaying the key, so it
        // leaves the note, which can name a guest, out.
        const { resolution } = resolved;
        return {
          exceptionId,
          resolution: { ...resolution, resolvedBy: { ...resolution.resolvedBy } },
        };
      },
    );
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    if (result.status !== 201) throw new Error(`unexpected stored status ${result.status}`);
    return c.json(result.body, 201);
  });
}
