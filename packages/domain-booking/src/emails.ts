/**
 * The booking's transactional email (lane 1, G2.11c and the G2.16 shim): the
 * confirmation with its receipt and management link, a fresh management link
 * on request, and the cancellation. Each is enqueued in the transaction that
 * causes it, through `enqueueMessage`, once per key, and rendered with the
 * operator's brand. Templates are versioned; a change to a template's words
 * is a new version.
 *
 * These run inside a booking's confirmation and cancellation, so they must
 * never throw for valid data: every stored text passes through `clean`, which
 * removes control characters and cuts what is too long.
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";
import {
  BALANCE_LINK_TEMPLATE,
  BALANCE_REMINDER_TEMPLATE,
  DEFAULT_LINK_TTL_SECONDS,
  type EmailBlock,
  enqueueMessage,
  TRIP_REMINDER_LEAD_HOURS,
  TRIP_REMINDER_MIN_NOTICE_HOURS,
  TRIP_REMINDER_TEMPLATE,
} from "@tidegrid/domain-messaging";
import { sql } from "kysely";
import { type BookingDetailView, getBookingDetail } from "./console.ts";
import {
  clean,
  extrasText,
  firstName,
  money,
  partyText,
  receiptRows,
  shortDay,
  singleLine,
  tripWhen,
} from "./format.ts";

/** The guest site's page that redeems a management link. */
export const MANAGE_PATH = "/manage";
export const CONFIRMATION_TEMPLATE = { key: "booking_confirmation", version: 1 } as const;
/**
 * An imported booking's welcome (W3-G2.13, 0049): its confirmation, worded for
 * a booking made and paid before the operator moved to TideGrid. It goes out
 * under the confirmation's key, so staff "send again" resends it.
 */
export const IMPORTED_WELCOME_TEMPLATE = { key: "booking_confirmation", version: 2 } as const;
export const MANAGE_LINK_TEMPLATE = { key: "booking_manage_link", version: 1 } as const;
/** Version 2: the refund is on its way, not already back (review M1). */
export const CANCELED_TEMPLATE = { key: "booking_canceled", version: 2 } as const;
export const REFUND_FAILED_TEMPLATE = { key: "booking_refund_failed", version: 1 } as const;
/** A booking moved to another trip (W3-G2.11-rest). */
export const RESCHEDULED_TEMPLATE = { key: "booking_rescheduled", version: 1 } as const;
/** The old address's notice that the booker's email changed (W3-G2.11-rest). */
export const CONTACT_CHANGED_TEMPLATE = { key: "booking_contact_changed", version: 1 } as const;
/** The trip reminder, a day before departure (W3-G2.16-rest). */
export const REMINDER_TEMPLATE = { key: TRIP_REMINDER_TEMPLATE, version: 1 } as const;

/** A private charter's balance reminder and the balance link staff send (W3-G2.8). */
export const BALANCE_REMINDER_EMAIL = { key: BALANCE_REMINDER_TEMPLATE, version: 1 } as const;
export const BALANCE_LINK_EMAIL = { key: BALANCE_LINK_TEMPLATE, version: 1 } as const;

/** A management link lasts three days once sent. */
export const MANAGE_LINK_TTL_SECONDS = DEFAULT_LINK_TTL_SECONDS;

const linkNote =
  "The button opens your booking once and works for three days. If it has expired or was already used, open it anyway and ask for a new link.";
const demoNote =
  "TideGrid demo: this booking is synthetic. No real card was charged and no money moves.";

/**
 * Saved by a CSV import, migration 0044: the booking's email stays held until
 * the batch that imported it has its email due (saved with send_at_cutover,
 * or released by an owner) and the import sweep has opened it (0049). From
 * then on it works as any booking's does.
 */
export async function importedEmailHeld(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<boolean> {
  const { rows } = await sql<{ held: boolean }>`
    select b.source = 'imported'
           and not exists (select 1 from import_booking_email_opened o
                            where o.tenant_id = b.tenant_id and o.booking_id = b.id) as held
      from bookings b
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0]?.held === true;
}

/**
 * No email to the booker: an imported booking still held, or one imported
 * with no address (it gets email once staff add one).
 */
async function bookerMailHeld(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<boolean> {
  const { rows } = await sql<{ held: boolean }>`
    select b.source = 'imported'
           and (s.booker_email is null
                or not exists (select 1 from import_booking_email_opened o
                                where o.tenant_id = b.tenant_id and o.booking_id = b.id)) as held
      from bookings b
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0]?.held === true;
}

async function detailFor(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<BookingDetailView & { booker: { name: string; email: string } }> {
  const detail = await getBookingDetail(trx, tenantId, bookingId, { withBooker: true });
  if (!detail?.booker) throw new Error("a booking for email was not found");
  return { ...detail, booker: detail.booker };
}

async function policyText(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<string> {
  const { rows } = await sql<{ cancellation_text: string }>`
    select v.cancellation_text
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join policy_versions v
        on v.tenant_id = o.tenant_id and v.product_id = o.product_id and v.version = o.policy_version
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0]?.cancellation_text ?? "";
}

function tripRows(detail: BookingDetailView): { label: string; value: string }[] {
  const where = detail.location.meetingPoint
    ? `${detail.location.meetingPoint}, ${detail.location.name}`
    : detail.location.name;
  const extras = extrasText(detail.extras);
  return [
    { label: "Reference", value: detail.reference },
    { label: "Trip", value: clean(detail.trip.productName, 1000) },
    { label: "When", value: tripWhen(detail.trip.startsAt, detail.trip.timeZone) },
    { label: "Meet at", value: clean(where, 1000) },
    ...(detail.location.meetingInstructions
      ? [{ label: "Directions", value: clean(detail.location.meetingInstructions, 1000) }]
      : []),
    { label: "Party", value: clean(partyText(detail.party), 1000) },
    ...(extras ? [{ label: "Extras", value: clean(extras, 1000) }] : []),
  ];
}

/** At most a receipt's worth of rows; a longer order says so. */
function receipt(detail: BookingDetailView): EmailBlock {
  const rows = receiptRows(detail.order, detail.payment === null);
  return {
    kind: "lines",
    rows:
      rows.length <= 118
        ? rows
        : [...rows.slice(0, 117), { label: "More lines in your booking", amount: "…" }],
  };
}

function subject(prefix: string, detail: BookingDetailView): string {
  const day = shortDay(detail.trip.startsAt, detail.trip.timeZone);
  return singleLine(`${prefix}: ${detail.trip.productName}, ${day}`, 200);
}

/**
 * Which message a composer writes. Without a key, the booking's own email,
 * once per booking. A staff resend (G2.16b) names its own key,
 * "booking.resend:<bookingId>:<generation>", so it is a new message.
 */
export interface ComposeOptions {
  dedupeKey?: string;
}

export interface ReminderOptions extends ComposeOptions {
  /**
   * Due at this moment instead of a day before the trip, with no minimum
   * notice: a reminder rewritten for a corrected address (W3-G2.11-rest)
   * keeps the moment the one it replaces had.
   */
  at?: Date;
}

/**
 * The confirmation, in the confirming transaction: receipt, trip, party, and
 * the management link, once per booking.
 */
export async function enqueueConfirmationEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  options: ComposeOptions = {},
): Promise<{ messageId: string; duplicate: boolean } | null> {
  // An imported booking's email waits for its batch's release (W3-G2.13, 0049).
  if (await bookerMailHeld(trx, ctx.tenantId, bookingId)) return null;
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const policy = await policyText(trx, ctx.tenantId, bookingId);
  if (detail.source === "imported") {
    return enqueueImportedWelcome(trx, ctx, bookingId, detail, policy, options);
  }
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "You're booked" },
    {
      kind: "paragraph",
      text: clean(
        `Thanks, ${firstName(detail.booker.name)}. Your booking is confirmed. Quote reference ${detail.reference} if you contact us.`,
        2000,
      ),
    },
    { kind: "details", rows: tripRows(detail) },
    receipt(detail),
    ...(detail.balance
      ? [
          {
            kind: "paragraph",
            text: `You paid a deposit of ${money(detail.balance.deposit)}. The balance of ${money(detail.balance.total - detail.balance.deposit)} is due by ${tripWhen(detail.balance.dueAt, detail.trip.timeZone)}. We will remind you, and nothing is charged without you.`,
          } as const,
        ]
      : []),
    {
      kind: "paragraph",
      text:
        detail.payment === null
          ? "This booking is complimentary, with our compliments: there is nothing to pay."
          : "Paid with a test payment. No real card was charged.",
    },
    {
      kind: "paragraph",
      text: "Use the button to name everyone in your party, or to cancel within the policy below.",
    },
    { kind: "action", label: "Manage your booking", href: "access_link" },
    { kind: "note", text: linkNote },
    ...(policy
      ? [{ kind: "paragraph", text: clean(`Cancellation policy: ${policy}`, 2000) } as const]
      : []),
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: options.dedupeKey ?? `booking.confirmation:${bookingId}`,
    template: CONFIRMATION_TEMPLATE.key,
    templateVersion: CONFIRMATION_TEMPLATE.version,
    to: { email: detail.booker.email, name: singleLine(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: subject(`Booking ${detail.reference} confirmed`, detail),
      preview: singleLine(`See you ${tripWhen(detail.trip.startsAt, detail.trip.timeZone)}.`, 200),
      blocks,
    },
    accessLink: {
      purpose: "booking_manage",
      path: MANAGE_PATH,
      ttlSeconds: MANAGE_LINK_TTL_SECONDS,
    },
  });
  return { messageId: result.messageId, duplicate: result.kind === "duplicate" };
}

/**
 * An imported booking's welcome, in place of its confirmation: the booking as
 * TideGrid now holds it, what was paid before, any balance and when it is due,
 * and the management link. Imported bookings
 * have no receipt lines and no TideGrid payment, and the guest cancels by
 * asking the operator, so it says neither "paid with" nor "cancel with the
 * button".
 */
async function enqueueImportedWelcome(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  detail: BookingDetailView & { booker: { name: string; email: string } },
  policy: string,
  options: ComposeOptions,
): Promise<{ messageId: string; duplicate: boolean }> {
  const total = detail.order.totals.total;
  const balance = detail.balance;
  const moneyRows: { label: string; value: string }[] = [
    ...(total > 0 ? [{ label: "Total", value: money(total) }] : []),
    ...(balance
      ? [
          { label: "Paid so far", value: money(balance.paidIn) },
          {
            label: "Balance",
            value:
              balance.owed > 0
                ? `${money(balance.owed)}, due by ${tripWhen(balance.dueAt, detail.trip.timeZone)}`
                : "Paid in full",
          },
        ]
      : []),
  ];
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "Your booking has moved to our new booking system" },
    {
      kind: "paragraph",
      text: clean(
        `Hi ${firstName(detail.booker.name)}. We now manage bookings with TideGrid, and your booking ${detail.reference} came across with everything you booked. Nothing about your trip has changed, and you don't need to book again. Quote reference ${detail.reference} if you contact us.`,
        2000,
      ),
    },
    { kind: "details", rows: [...tripRows(detail), ...moneyRows] },
    {
      kind: "paragraph",
      text:
        balance && balance.owed > 0
          ? "You paid us before the move, and that payment came across with your booking. The balance is due by the date above, and we'll remind you before then."
          : total > 0
            ? "You paid us before the move, and that payment came across with your booking. There is nothing more to pay."
            : "There is nothing to pay here.",
    },
    {
      kind: "paragraph",
      text: "Use the button to see your booking and to name everyone in your party. To cancel, contact us.",
    },
    { kind: "action", label: "Manage your booking", href: "access_link" },
    { kind: "note", text: linkNote },
    ...(policy
      ? [{ kind: "paragraph", text: clean(`Cancellation policy: ${policy}`, 2000) } as const]
      : []),
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: options.dedupeKey ?? `booking.confirmation:${bookingId}`,
    template: IMPORTED_WELCOME_TEMPLATE.key,
    templateVersion: IMPORTED_WELCOME_TEMPLATE.version,
    to: { email: detail.booker.email, name: singleLine(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: subject(`Booking ${detail.reference}: now on our new booking system`, detail),
      preview: singleLine(
        `Your booking came across. See you ${tripWhen(detail.trip.startsAt, detail.trip.timeZone)}.`,
        200,
      ),
      blocks,
    },
    accessLink: {
      purpose: "booking_manage",
      path: MANAGE_PATH,
      ttlSeconds: MANAGE_LINK_TTL_SECONDS,
    },
  });
  return { messageId: result.messageId, duplicate: result.kind === "duplicate" };
}

/**
 * A fresh management link, on the guest's request; `requestKey` names the
 * request, so a retried request enqueues nothing new. Sending it supersedes
 * the links earlier emails carried.
 */
export async function enqueueManageLinkEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  requestKey: string,
): Promise<{ messageId: string; duplicate: boolean } | null> {
  // An imported booking's email waits for its batch's release (W3-G2.13, 0049).
  if (await bookerMailHeld(trx, ctx.tenantId, bookingId)) return null;
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "Your booking link" },
    {
      kind: "paragraph",
      text: clean(
        `Here is a new link to booking ${detail.reference}: ${detail.trip.productName}, ${tripWhen(detail.trip.startsAt, detail.trip.timeZone)}.`,
        2000,
      ),
    },
    { kind: "action", label: "Manage your booking", href: "access_link" },
    {
      kind: "note",
      text: `${linkNote} Links in earlier emails about this booking no longer work.`,
    },
    {
      kind: "paragraph",
      text: "If you did not ask for this link, you can ignore this email. Your booking has not changed.",
    },
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: `booking.manage_link:${bookingId}:${requestKey}`,
    template: MANAGE_LINK_TEMPLATE.key,
    templateVersion: MANAGE_LINK_TEMPLATE.version,
    to: { email: detail.booker.email, name: singleLine(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: singleLine(`Your link to booking ${detail.reference}`, 200),
      preview: "Open your booking to name your party or cancel within the policy.",
      blocks,
    },
    accessLink: {
      purpose: "booking_manage",
      path: MANAGE_PATH,
      ttlSeconds: MANAGE_LINK_TTL_SECONDS,
    },
  });
  return { messageId: result.messageId, duplicate: result.kind === "duplicate" };
}

/**
 * The trip reminder, written with the confirmation and sent a day before the
 * trip leaves, once per booking. A booking made within two days of
 * departure gets none: its confirmation is recent enough to be the reminder.
 * The delivery job checks again when it is due (see domain-messaging's
 * reminders.ts), and a cancellation cancels it.
 *
 * Its words are rendered now, as every message's are: a later change to the
 * trip's meeting point or the operator's brand is not in it.
 */
export async function enqueueReminderEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  options: ReminderOptions = {},
): Promise<{ messageId: string; duplicate: boolean } | null> {
  // An imported booking's email waits for its batch's release (W3-G2.13, 0049).
  if (await bookerMailHeld(trx, ctx.tenantId, bookingId)) return null;
  const { rows } = await sql<{ due: Date; worth: boolean }>`
    select t.starts_at - make_interval(hours => ${TRIP_REMINDER_LEAD_HOURS}) as due,
           t.starts_at - make_interval(hours => ${TRIP_REMINDER_LEAD_HOURS})
             > now() + make_interval(hours => ${TRIP_REMINDER_MIN_NOTICE_HOURS}) as worth
      from bookings b
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where b.tenant_id = ${ctx.tenantId} and b.id = ${bookingId}`.execute(trx);
  const timing = rows[0];
  if (!timing) throw new Error("a booking for email was not found");
  if (!options.at && !timing.worth) return null;
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const when = tripWhen(detail.trip.startsAt, detail.trip.timeZone);
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "Your trip is coming up" },
    {
      kind: "paragraph",
      text: clean(
        `Hi ${firstName(detail.booker.name)}. A reminder of booking ${detail.reference}: ${detail.trip.productName}, ${when}.`,
        2000,
      ),
    },
    { kind: "details", rows: tripRows(detail) },
    {
      kind: "paragraph",
      text: "Use the button to see your booking or to name everyone in your party.",
    },
    { kind: "action", label: "Manage your booking", href: "access_link" },
    { kind: "note", text: linkNote },
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    // A moved booking's reminder (W3-G2.11-rest) names the move in its key.
    dedupeKey: options.dedupeKey ?? `booking.reminder:${bookingId}`,
    template: REMINDER_TEMPLATE.key,
    templateVersion: REMINDER_TEMPLATE.version,
    to: { email: detail.booker.email, name: singleLine(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: subject("Trip reminder", detail),
      preview: singleLine(`See you ${when}.`, 200),
      blocks,
    },
    accessLink: {
      purpose: "booking_manage",
      path: MANAGE_PATH,
      ttlSeconds: MANAGE_LINK_TTL_SECONDS,
    },
    notBefore: options.at ?? timing.due,
  });
  return { messageId: result.messageId, duplicate: result.kind === "duplicate" };
}

/**
 * A private charter's balance email (W3-G2.8): a reminder, written with the
 * confirmation and sent 7 days and 1 day before the due date (`notBefore`),
 * or the balance link staff send now. Its words say when the balance is due,
 * not how much is left, because a payment recorded later changes that; the
 * button opens the booking, which shows what is owed and takes the payment.
 * The delivery job cancels one whose balance was paid or whose booking was
 * canceled by the time it is due (`balance_settled`).
 */
export async function enqueueBalanceEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  options:
    | { kind: "reminder"; dedupeKey: string; notBefore: Date }
    | { kind: "link"; dedupeKey: string },
): Promise<{ messageId: string; duplicate: boolean } | null> {
  // An imported booking's email waits for its batch's release (W3-G2.13, 0049).
  if (await bookerMailHeld(trx, ctx.tenantId, bookingId)) return null;
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  if (!detail.balance) throw new Error("a balance email for a booking with no balance");
  const due = tripWhen(detail.balance.dueAt, detail.trip.timeZone);
  const template = options.kind === "reminder" ? BALANCE_REMINDER_EMAIL : BALANCE_LINK_EMAIL;
  const blocks: EmailBlock[] = [
    {
      kind: "heading",
      text: options.kind === "reminder" ? "Your balance is coming due" : "Pay your balance",
    },
    {
      kind: "paragraph",
      text: clean(
        `Hi ${firstName(detail.booker.name)}. The balance on booking ${detail.reference} (${detail.trip.productName}, ${tripWhen(detail.trip.startsAt, detail.trip.timeZone)}) is due by ${due}.`,
        2000,
      ),
    },
    { kind: "details", rows: tripRows(detail) },
    {
      kind: "paragraph",
      text: "Use the button to see what is left to pay and pay it. If you have already paid, you can ignore this email.",
    },
    { kind: "action", label: "Pay your balance", href: "access_link" },
    { kind: "note", text: linkNote },
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: options.dedupeKey,
    template: template.key,
    templateVersion: template.version,
    to: { email: detail.booker.email, name: singleLine(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: subject(
        `Balance due by ${shortDay(detail.balance.dueAt, detail.trip.timeZone)}`,
        detail,
      ),
      preview: singleLine(`Booking ${detail.reference}: the balance is due by ${due}.`, 200),
      blocks,
    },
    accessLink: {
      purpose: "booking_manage",
      path: MANAGE_PATH,
      ttlSeconds: MANAGE_LINK_TTL_SECONDS,
    },
    ...(options.kind === "reminder" ? { notBefore: options.notBefore } : {}),
  });
  return { messageId: result.messageId, duplicate: result.kind === "duplicate" };
}

/** The cancellation, in the canceling transaction, once per booking. */
export async function enqueueCancellationEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  options: ComposeOptions = {},
): Promise<{ messageId: string; duplicate: boolean } | null> {
  // An imported booking's email waits for its batch's release (W3-G2.13, 0049).
  if (await bookerMailHeld(trx, ctx.tenantId, bookingId)) return null;
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const c = detail.cancellation;
  if (!c) throw new Error("a cancellation email needs the booking's cancellation");
  const refund =
    c.refundAmount > 0
      ? c.refundAmount === c.paidAmount
        ? `${money(c.refundAmount)}, everything you paid, on its way back to your original payment method`
        : `${money(c.refundAmount)} of the ${money(c.paidAmount)} you paid, on its way back to your original payment method`
      : c.creditAmount > 0
        ? "None to your card: the value is booking credit instead (below)"
        : detail.source === "imported"
          ? "Not through TideGrid: you paid us before we moved to TideGrid, so we'll contact you about any refund"
          : c.paidAmount === 0 && detail.payment === null
            ? "None: the booking was complimentary, so nothing was paid"
            : c.overridden
              ? "None"
              : `None: the policy gives no refund ${c.beforeCutoff ? "for this booking" : "after its cutoff"}`;
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "Your booking is canceled" },
    {
      kind: "paragraph",
      text: clean(
        `We have canceled booking ${detail.reference}: ${detail.trip.productName}, ${tripWhen(detail.trip.startsAt, detail.trip.timeZone)}. ${detail.party.guests === 1 ? "Your place has" : "Your places have"} gone back on sale.`,
        2000,
      ),
    },
    {
      kind: "details",
      rows: [
        { label: "Reference", value: detail.reference },
        { label: "Refund", value: clean(refund, 1000) },
        ...(c.creditAmount > 0
          ? [
              {
                label: "Booking credit",
                value: clean(
                  `${money(c.creditAmount)}, held for you under the email you booked with`,
                  1000,
                ),
              },
            ]
          : []),
        { label: "Party", value: clean(partyText(detail.party), 1000) },
      ],
    },
    ...(c.refundAmount > 0
      ? [
          {
            kind: "paragraph",
            text: "We've asked the payment provider to return it. Refunds usually reach your account within 5 to 10 business days. If the refund can't be made, we'll email you.",
          } as const,
        ]
      : []),
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: options.dedupeKey ?? `booking.canceled:${bookingId}`,
    template: CANCELED_TEMPLATE.key,
    templateVersion: CANCELED_TEMPLATE.version,
    to: { email: detail.booker.email, name: singleLine(detail.booker.name, 120) },
    bookingId,
    content: { subject: subject(`Booking ${detail.reference} canceled`, detail), blocks },
  });
  return { messageId: result.messageId, duplicate: result.kind === "duplicate" };
}

/**
 * A booking moved to another trip (W3-G2.11-rest), in the moving
 * transaction, once per move: the new time and place, the old time for
 * reference, and a fresh management link. The price did not change.
 */
export async function enqueueRescheduledEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  move: { rescheduleId: string; fromStartsAt: string },
): Promise<{ messageId: string; duplicate: boolean } | null> {
  // An imported booking's email waits for its batch's release (W3-G2.13, 0049).
  if (await bookerMailHeld(trx, ctx.tenantId, bookingId)) return null;
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const when = tripWhen(detail.trip.startsAt, detail.trip.timeZone);
  const was = tripWhen(move.fromStartsAt, detail.trip.timeZone);
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "Your booking has moved" },
    {
      kind: "paragraph",
      text: clean(
        `Hi ${firstName(detail.booker.name)}. Booking ${detail.reference} is now for ${detail.trip.productName}, ${when}. It was for ${was}.`,
        2000,
      ),
    },
    { kind: "details", rows: tripRows(detail) },
    {
      kind: "paragraph",
      text: "The price is unchanged: nothing more was charged and nothing was refunded.",
    },
    { kind: "action", label: "Manage your booking", href: "access_link" },
    { kind: "note", text: linkNote },
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: `booking.rescheduled:${move.rescheduleId}`,
    template: RESCHEDULED_TEMPLATE.key,
    templateVersion: RESCHEDULED_TEMPLATE.version,
    to: { email: detail.booker.email, name: singleLine(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: subject(`Booking ${detail.reference} moved`, detail),
      preview: singleLine(`Now ${when}.`, 200),
      blocks,
    },
    accessLink: {
      purpose: "booking_manage",
      path: MANAGE_PATH,
      ttlSeconds: MANAGE_LINK_TTL_SECONDS,
    },
  });
  return { messageId: result.messageId, duplicate: result.kind === "duplicate" };
}

/**
 * The follow-up when the payment provider refuses a cancellation's refund,
 * in the transaction that records the refusal, once per booking: the
 * cancellation email said the refund was on its way.
 */
export async function enqueueRefundFailedEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  amount: number,
): Promise<{ messageId: string } | null> {
  // An imported booking's email waits for its batch's release (W3-G2.13, 0049).
  if (await bookerMailHeld(trx, ctx.tenantId, bookingId)) return null;
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "Your refund hasn't gone through yet" },
    {
      kind: "paragraph",
      text: clean(
        `We tried to return ${money(amount)} for canceled booking ${detail.reference}: ${detail.trip.productName}, ${tripWhen(detail.trip.startsAt, detail.trip.timeZone)}. The payment provider refused it, so the money has not been returned yet.`,
        2000,
      ),
    },
    {
      kind: "details",
      rows: [
        { label: "Reference", value: detail.reference },
        { label: "Refund", value: `${money(amount)}, not returned yet` },
      ],
    },
    {
      kind: "paragraph",
      text: "We'll contact you to sort it out. You can also reply to this email.",
    },
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: `booking.refund_failed:${bookingId}`,
    template: REFUND_FAILED_TEMPLATE.key,
    templateVersion: REFUND_FAILED_TEMPLATE.version,
    to: { email: detail.booker.email, name: singleLine(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: subject(`Booking ${detail.reference}: refund not sent yet`, detail),
      blocks,
    },
  });
  return { messageId: result.messageId };
}

/**
 * Hide most of an address: the first letter of the mailbox and of the
 * domain, and the domain's last part. "ava.guest@example.test" reads
 * "a•••@e•••.test". Enough for the owner of the old address to recognise a
 * change they made, not enough to learn a stranger's address.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}\u2022\u2022\u2022@${host.slice(0, 1)}\u2022\u2022\u2022${tld}`;
}

/**
 * The notice to the booker's old address that the booking's email changed
 * (W3-G2.11-rest), in the changing transaction, once per change. It carries
 * no link and only a masked new address: whoever reads the old inbox learns
 * that a change happened and whom to ask, nothing they could use.
 */
export async function enqueueContactChangedEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
  change: { contactChangeId: string; oldEmail: string | null; oldName: string; newEmail: string },
): Promise<{ messageId: string; duplicate: boolean } | null> {
  // An imported booking's email waits for its batch's release (W3-G2.13, 0049).
  if (await bookerMailHeld(trx, ctx.tenantId, bookingId)) return null;
  // A booker imported with no email had no old address to tell.
  const oldEmail = change.oldEmail;
  if (!oldEmail) return null;
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const blocks: EmailBlock[] = [
    { kind: "heading", text: "Your booking's email address changed" },
    {
      kind: "paragraph",
      text: clean(
        `Hi ${firstName(change.oldName)}. The email address on booking ${detail.reference} (${detail.trip.productName}, ${tripWhen(detail.trip.startsAt, detail.trip.timeZone)}) was changed to ${maskEmail(change.newEmail)}. Emails about this booking now go there, and links sent to this address no longer work.`,
        2000,
      ),
    },
    {
      kind: "paragraph",
      text: "If you made this change, there is nothing more to do. If you did not, reply to this email and we'll help.",
    },
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: `booking.contact_changed:${change.contactChangeId}`,
    template: CONTACT_CHANGED_TEMPLATE.key,
    templateVersion: CONTACT_CHANGED_TEMPLATE.version,
    to: { email: oldEmail, name: singleLine(change.oldName, 120) },
    bookingId,
    content: {
      subject: singleLine(`Booking ${detail.reference}: email address changed`, 200),
      blocks,
    },
  });
  return { messageId: result.messageId, duplicate: result.kind === "duplicate" };
}
