import type {
  BookingNote,
  BookingNoteCreated,
  BookingNoteCreatedResponse,
  BookingNotesResponse,
} from "@tidegrid/contracts";
import { call, errorCode, failureOf, type ReadFailure, tenantPath } from "../http.ts";
import { isInstant, isInt, isString, type Read } from "./api.ts";

/**
 * A booking's internal notes (G2.12c): owners and booking staff read and add
 * them; finance does neither. A note is never edited or removed. Neither call
 * throws.
 */

export interface NotesPage {
  notes: BookingNote[];
  total: number;
}

export function isNote(n: Partial<BookingNote> | null | undefined): n is BookingNote {
  return isString(n?.body) && isCreated(n);
}

/** The API's answer to an added note: its id, author, and time, without its text. */
function isCreated(n: Partial<BookingNoteCreated> | null | undefined): n is BookingNoteCreated {
  return (
    isString(n?.id) &&
    isString(n.author?.userId) &&
    isString(n.author?.name) &&
    isInstant(n.createdAt)
  );
}

const notesPath = (tenantId: string, bookingId: string) =>
  `${tenantPath(tenantId)}/bookings/${encodeURIComponent(bookingId)}/notes`;

export async function loadNotes(
  tenantId: string,
  bookingId: string,
  signal?: AbortSignal,
): Promise<Read<NotesPage>> {
  try {
    const res = await call(
      notesPath(tenantId, bookingId),
      { headers: { accept: "application/json" } },
      signal,
    );
    if (!res.ok) return { kind: "failed", reason: await failureOf(res) };
    const body = (await res.json().catch(() => null)) as Partial<BookingNotesResponse> | null;
    if (!Array.isArray(body?.notes) || !body.notes.every(isNote) || !isInt(body.total)) {
      return { kind: "failed", reason: "unreadable" };
    }
    return { kind: "ok", value: { notes: body.notes, total: body.total } };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

/** Why a note was not added. `key_reused`: the key went with a different note. */
export type NoteFailure = ReadFailure | "key_reused";

export type AddNoteResult =
  | { kind: "added"; note: BookingNote }
  | { kind: "failed"; reason: NoteFailure };

/**
 * Add a note. `key` is the Idempotency-Key: a new one for each new note, the
 * same one when the same note is sent again after a failure, so the API adds
 * it once. The API answers with the note's id, author, and time, not its text,
 * so a stored replay holds no copy of the text; the note added is the text
 * sent, as the API keeps it (trimmed).
 */
export async function addNote(
  tenantId: string,
  bookingId: string,
  body: string,
  key: string,
): Promise<AddNoteResult> {
  try {
    const res = await call(notesPath(tenantId, bookingId), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ body }),
    });
    if (res.ok) {
      const data = (await res
        .json()
        .catch(() => null)) as Partial<BookingNoteCreatedResponse> | null;
      const created = data?.note;
      return isCreated(created)
        ? {
            kind: "added",
            note: {
              id: created.id,
              body: body.trim(),
              author: { userId: created.author.userId, name: created.author.name },
              createdAt: created.createdAt,
            },
          }
        : { kind: "failed", reason: "unreadable" };
    }
    if (res.status === 422 && (await errorCode(res.clone())) === "idempotency_key_reused") {
      return { kind: "failed", reason: "key_reused" };
    }
    return { kind: "failed", reason: await failureOf(res) };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  }
}
