/**
 * The tenant-wide email exceptions read (W1-EMAIL-EXC, a follow-up to G2.16b
 * D9 A): every message of one tenant that stopped in the `failed` state,
 * newest first, a page at a time. Staff follow each one up on its booking.
 *
 * - Tenant-scoped twice: the caller's transaction runs under the tenant's
 *   row-level security (`inTenantTransaction`), and every table in the query
 *   is filtered by `tenant_id` as well.
 * - No recipient, subject, body, or name leaves: the query selects none.
 * - A failed message never changes again (migration 0009's trigger), so a
 *   cursor keeps naming the same place in the list.
 * - No index (D3, coordinator default): at demo size the tenant's messages
 *   are read in full. The "sent later" check uses `email_messages_booking_idx`.
 */
import { isUuid, type TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { STAFF_RESEND_TOPIC } from "./enqueue.ts";

/** How a failed message ended, by its last error. */
export type EmailExceptionState = "failed" | "outcome_unknown" | "delivery_failed";

/** Whose card shows the message: the booking's Email card, or its Waivers card. */
export type EmailExceptionKind = "booking" | "waiver";

export interface EmailExceptionView {
  id: string;
  template: string;
  kind: EmailExceptionKind;
  state: EmailExceptionState;
  attempts: number;
  failureCode: string;
  failedAt: string;
  staffResend: boolean;
  /** A later message of the same template, booking, participant, and subject was sent. */
  laterSent: boolean;
  booking: { id: string; reference: string; timeZone: string } | null;
}

export type EmailExceptionsPage =
  | { kind: "page"; exceptions: EmailExceptionView[]; nextBefore: string | null }
  | { kind: "cursor_invalid" };

/** The most a page holds; the contract caps `limit` here too. */
export const MAX_EMAIL_EXCEPTIONS_PAGE = 100;

interface Row {
  id: string;
  template: string;
  attempts: number;
  last_error_code: string;
  failed_at: Date | string;
  staff_resend: boolean;
  later_sent: boolean;
  booking_id: string | null;
  reference: string | null;
  time_zone: string | null;
}

/** A failed message's state for the list, by its last error code. */
export function exceptionState(code: string): EmailExceptionState {
  if (code === "outcome_unknown") return "outcome_unknown";
  if (code === "delivery_failed") return "delivery_failed";
  return "failed";
}

/** A waiver request, or any other waiver email, goes with the Waivers card (G2.16b D11). */
export function exceptionKind(template: string): EmailExceptionKind {
  return template.startsWith("waiver_") ? "waiver" : "booking";
}

const iso = (v: Date | string) => (typeof v === "string" ? new Date(v) : v).toISOString();

/**
 * One page of the tenant's failed messages, newest first by when delivery
 * stopped, then by id. `before` is the last id of the previous page; one that
 * names no failed message of this tenant answers `cursor_invalid`, so another
 * tenant's id finds nothing either way.
 */
export async function listEmailExceptions(
  trx: TenantTransaction,
  tenantId: string,
  query: { limit: number; before?: string },
): Promise<EmailExceptionsPage> {
  if (!isUuid(tenantId)) throw new TypeError("tenantId must be a UUID");
  if (
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > MAX_EMAIL_EXCEPTIONS_PAGE
  ) {
    throw new RangeError(`a page holds 1 to ${MAX_EMAIL_EXCEPTIONS_PAGE} exceptions`);
  }
  if (query.before !== undefined) {
    if (!isUuid(query.before)) return { kind: "cursor_invalid" };
    const { rows } = await sql<{ id: string }>`
      select id from email_messages
       where tenant_id = ${tenantId} and id = ${query.before} and state = 'failed'`.execute(trx);
    if (rows.length === 0) return { kind: "cursor_invalid" };
  }
  const cursor =
    query.before === undefined
      ? sql``
      : sql`and (m.failed_at, m.id) < (
              select c.failed_at, c.id from email_messages c
               where c.tenant_id = ${tenantId} and c.id = ${query.before}::uuid)`;
  const { rows } = await sql<Row>`
    select m.id, m.template, m.attempts, m.last_error_code, m.failed_at,
           starts_with(m.dedupe_key, ${`${STAFF_RESEND_TOPIC}:`}) as staff_resend,
           exists (
             select 1 from email_messages n
              where n.tenant_id = m.tenant_id and n.booking_id = m.booking_id
                and n.template = m.template
                and n.participant_id is not distinct from m.participant_id
                and n.subject_ref is not distinct from m.subject_ref
                and n.state = 'sent'
                and (n.created_at, n.id) > (m.created_at, m.id)) as later_sent,
           b.id as booking_id, b.reference, t.time_zone
      from email_messages m
      left join bookings b on b.tenant_id = m.tenant_id and b.id = m.booking_id
      left join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
     where m.tenant_id = ${tenantId} and m.state = 'failed'
       ${cursor}
     order by m.failed_at desc, m.id desc
     limit ${query.limit + 1}`.execute(trx);
  const page = rows.slice(0, query.limit);
  return {
    kind: "page",
    exceptions: page.map((row) => ({
      id: row.id,
      template: row.template,
      kind: exceptionKind(row.template),
      state: exceptionState(row.last_error_code),
      attempts: row.attempts,
      failureCode: row.last_error_code,
      failedAt: iso(row.failed_at),
      staffResend: row.staff_resend,
      laterSent: row.later_sent,
      booking:
        row.booking_id !== null && row.reference !== null && row.time_zone !== null
          ? { id: row.booking_id, reference: row.reference, timeZone: row.time_zone }
          : null,
    })),
    nextBefore: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
