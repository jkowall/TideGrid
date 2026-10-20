/**
 * Internal booking notes (G2.12c). Staff add short notes to a booking; a note
 * is never edited or removed, for any role (migration 0008). The database
 * sets each note's author, request, and time from the transaction, so the
 * note is always the signed-in staff member's own.
 *
 * A note's body is text a person typed and may mention a guest. It never
 * enters an audit row, an event, or a log: the audit row names the note's id.
 */
import {
  isUuid,
  recordAudit,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { iso } from "./views.ts";

/** The newest notes a read returns; `total` counts every one. */
export const NOTES_LIMIT = 200;

export interface BookingNoteView {
  id: string;
  body: string;
  author: { userId: string; name: string };
  createdAt: string;
}

interface NoteRow {
  id: string;
  body: string;
  author_user_id: string;
  author_name: string;
  created_at: Date | string;
}

function view(row: NoteRow): BookingNoteView {
  return {
    id: row.id,
    body: row.body,
    author: { userId: row.author_user_id, name: row.author_name },
    createdAt: iso(row.created_at),
  };
}

async function bookingExists(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<boolean> {
  if (!isUuid(bookingId)) return false;
  const found = await trx
    .selectFrom("bookings")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", bookingId)
    .executeTakeFirst();
  return found !== undefined;
}

/**
 * A booking's notes, newest first, with each author as this operator names
 * them. Null when the booking is not this tenant's, so an unknown id and
 * another tenant's read the same.
 */
export async function listBookingNotes(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<{ notes: BookingNoteView[]; total: number } | null> {
  if (!(await bookingExists(trx, tenantId, bookingId))) return null;
  const { rows } = await sql<NoteRow & { total: number }>`
    select n.id, n.body, n.author_user_id, m.display_name as author_name, n.created_at,
           count(*) over ()::int as total
      from booking_notes n
      join tenant_memberships m on m.tenant_id = n.tenant_id and m.user_id = n.author_user_id
     where n.tenant_id = ${tenantId} and n.booking_id = ${bookingId}::uuid
     order by n.created_at desc, n.id desc
     limit ${NOTES_LIMIT}`.execute(trx);
  return { notes: rows.map(view), total: rows[0]?.total ?? 0 };
}

export type AddBookingNoteResult =
  | { kind: "added"; note: BookingNoteView }
  | { kind: "booking_not_found" };

/**
 * Add a note to one of this tenant's bookings, as the transaction's staff
 * actor, and record it in the audit history. The body is the contract's:
 * trimmed, 1 to 500 characters, line breaks allowed.
 */
export async function addBookingNote(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { bookingId: string; body: string },
): Promise<AddBookingNoteResult> {
  if (!(await bookingExists(trx, ctx.tenantId, input.bookingId))) {
    return { kind: "booking_not_found" };
  }
  const inserted = await trx
    .insertInto("booking_notes")
    .values({ tenant_id: ctx.tenantId, booking_id: input.bookingId, body: input.body })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  const { rows } = await sql<NoteRow>`
    select n.id, n.body, n.author_user_id, m.display_name as author_name, n.created_at
      from booking_notes n
      join tenant_memberships m on m.tenant_id = n.tenant_id and m.user_id = n.author_user_id
     where n.tenant_id = ${ctx.tenantId} and n.id = ${inserted.id}::uuid`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("the note just written cannot be read back");
  await recordAudit(trx, ctx, {
    action: "booking.note_added",
    subjectType: "booking",
    subjectId: input.bookingId,
    after: { noteId: row.id },
  });
  return { kind: "added", note: view(row) };
}
