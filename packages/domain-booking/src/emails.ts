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
  DEFAULT_LINK_TTL_SECONDS,
  type EmailBlock,
  enqueueMessage,
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
  tripWhen,
} from "./format.ts";

/** The guest site's page that redeems a management link. */
export const MANAGE_PATH = "/manage";
export const CONFIRMATION_TEMPLATE = { key: "booking_confirmation", version: 1 } as const;
export const MANAGE_LINK_TEMPLATE = { key: "booking_manage_link", version: 1 } as const;
export const CANCELED_TEMPLATE = { key: "booking_canceled", version: 1 } as const;

/** A management link lasts three days once sent. */
export const MANAGE_LINK_TTL_SECONDS = DEFAULT_LINK_TTL_SECONDS;

const linkNote =
  "The button opens your booking once and works for three days. If it has expired or was already used, open it anyway and ask for a new link.";
const demoNote =
  "TideGrid demo: this booking is synthetic. No real card was charged and no money moves.";

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
  const rows = receiptRows(detail.order);
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
  return clean(`${prefix}: ${detail.trip.productName}, ${day}`, 200);
}

/**
 * The confirmation, in the confirming transaction: receipt, trip, party, and
 * the management link, once per booking.
 */
export async function enqueueConfirmationEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
): Promise<{ messageId: string }> {
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const policy = await policyText(trx, ctx.tenantId, bookingId);
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
    { kind: "paragraph", text: "Paid with a test payment. No real card was charged." },
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
    dedupeKey: `booking.confirmation:${bookingId}`,
    template: CONFIRMATION_TEMPLATE.key,
    templateVersion: CONFIRMATION_TEMPLATE.version,
    to: { email: detail.booker.email, name: clean(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: subject(`Booking ${detail.reference} confirmed`, detail),
      preview: clean(`See you ${tripWhen(detail.trip.startsAt, detail.trip.timeZone)}.`, 200),
      blocks,
    },
    accessLink: {
      purpose: "booking_manage",
      path: MANAGE_PATH,
      ttlSeconds: MANAGE_LINK_TTL_SECONDS,
    },
  });
  return { messageId: result.messageId };
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
): Promise<{ messageId: string; duplicate: boolean }> {
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
    to: { email: detail.booker.email, name: clean(detail.booker.name, 120) },
    bookingId,
    content: {
      subject: clean(`Your link to booking ${detail.reference}`, 200),
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

/** The cancellation, in the canceling transaction, once per booking. */
export async function enqueueCancellationEmail(
  trx: TenantTransaction,
  ctx: TenantContext,
  bookingId: string,
): Promise<{ messageId: string }> {
  const detail = await detailFor(trx, ctx.tenantId, bookingId);
  const c = detail.cancellation;
  if (!c) throw new Error("a cancellation email needs the booking's cancellation");
  const refund =
    c.refundAmount > 0
      ? c.refundAmount === c.paidAmount
        ? `${money(c.refundAmount)}, everything you paid, back to your original payment method`
        : `${money(c.refundAmount)} of the ${money(c.paidAmount)} you paid, back to your original payment method`
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
        { label: "Party", value: clean(partyText(detail.party), 1000) },
      ],
    },
    ...(c.refundAmount > 0
      ? [
          {
            kind: "paragraph",
            text: "Refunds usually reach your account within 5 to 10 business days.",
          } as const,
        ]
      : []),
    { kind: "note", text: demoNote },
  ];
  const result = await enqueueMessage(trx, ctx, {
    dedupeKey: `booking.canceled:${bookingId}`,
    template: CANCELED_TEMPLATE.key,
    templateVersion: CANCELED_TEMPLATE.version,
    to: { email: detail.booker.email, name: clean(detail.booker.name, 120) },
    bookingId,
    content: { subject: subject(`Booking ${detail.reference} canceled`, detail), blocks },
  });
  return { messageId: result.messageId };
}
