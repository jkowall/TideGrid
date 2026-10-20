import type { BookingNote } from "@tidegrid/contracts";
import { Button, Icon, Notice, Skeleton } from "@tidegrid/design-system/components";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { newIdempotencyKey } from "../calendar/api.ts";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { instantText } from "./model.ts";
import { addNote, loadNotes, type NoteFailure, type NotesPage } from "./notes-api.ts";
import { canRetry, failureText } from "./States.tsx";

/**
 * A booking's internal notes (G2.12c): what a guest asked on the phone, what
 * the dock should know. Owners and booking staff read and add them; finance
 * never sees this panel (roles.ts). A note is never edited or removed, and it
 * names who wrote it and when, on the marina's clock.
 */

export const noteLimit = 500;

/**
 * How long a note is, as the API counts it: code points, after trimming. An
 * emoji is one character, and a line break left at the end is none.
 */
export function noteLength(body: string): number {
  return [...body.trim()].length;
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; page: NotesPage }
  | { kind: "failed"; reason: ReadFailure; retrying: boolean };

export function Notes({
  tenantId,
  tenantName,
  bookingId,
  zone,
}: {
  tenantId: string;
  tenantName: string;
  bookingId: string;
  /** The marina's zone: notes are dated on its clock. */
  zone: string;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retrying = useRef(false);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  /** Try again went with its notice: the card's heading takes focus. */
  const focusHeadingOnLoad = useRef(false);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retrying.current;
    retrying.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    void loadNotes(tenantId, bookingId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      focusHeadingOnLoad.current = retry && (result.kind === "ok" || !canRetry(result.reason));
      setLoad(
        result.kind === "ok"
          ? { kind: "ready", page: result.value }
          : { kind: "failed", reason: result.reason, retrying: false },
      );
    });
    return () => controller.abort();
  }, [tenantId, bookingId, attempt]);

  // Only when focus went with the button, never from where the person moved it.
  useEffect(() => {
    if (load.kind === "loading" || !focusHeadingOnLoad.current) return;
    focusHeadingOnLoad.current = false;
    if (focusIsLost()) heading.current?.focus();
  }, [load]);

  const added = (note: BookingNote) =>
    setLoad((current) =>
      current.kind === "ready"
        ? {
            kind: "ready",
            page: { notes: [note, ...current.page.notes], total: current.page.total + 1 },
          }
        : current,
    );

  return (
    <section className="console-card bd-card bd-notes" aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1}>
        Notes
      </h2>
      <NoteForm tenantId={tenantId} tenantName={tenantName} bookingId={bookingId} onAdded={added} />
      {load.kind === "loading" && (
        <div className="bd-notes__skeleton" aria-hidden="true">
          <Skeleton variant="text" width="min(28rem, 90%)" />
          <Skeleton variant="text" width="min(16rem, 60%)" />
        </div>
      )}
      {load.kind === "failed" && (
        <Notice
          tone="error"
          title={failureText(load.reason, { noun: "the notes", tenantName }).title}
          actions={
            canRetry(load.reason) ? (
              <Button
                icon="refresh"
                busy={load.retrying}
                busyLabel="Trying again…"
                onClick={() => {
                  retrying.current = true;
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            ) : undefined
          }
        >
          <p>{failureText(load.reason, { noun: "the notes", tenantName }).body}</p>
        </Notice>
      )}
      {load.kind === "ready" &&
        (load.page.notes.length === 0 ? (
          <p className="bd-notes__empty">No notes on this booking yet.</p>
        ) : (
          <>
            <ol className="bd-notes__list">
              {load.page.notes.map((note) => (
                <li key={note.id} className="bd-note">
                  <p className="bd-note__body">{note.body}</p>
                  <p className="bd-note__meta">
                    <span className="bd-note__author">{note.author.name}</span>
                    <span aria-hidden="true"> · </span>
                    <span className="tg-visually-hidden">, </span>
                    <time dateTime={note.createdAt}>{instantText(note.createdAt, zone)}</time>
                  </p>
                </li>
              ))}
            </ol>
            {load.page.total > load.page.notes.length && (
              <p className="bd-notes__more">
                Showing the newest {load.page.notes.length} of {load.page.total} notes.
              </p>
            )}
          </>
        ))}
    </section>
  );
}

const noteProblems: Record<NoteFailure, string> = {
  signed_out: "You're signed out. Sign in again, then add the note.",
  forbidden: "Your role can't add notes. Owners and booking staff can.",
  suspended: "While this operator is suspended, notes can't be added.",
  no_access: "You no longer have access to this operator. Ask one of its owners.",
  not_found: "This booking isn't here any more, so the note wasn't added.",
  rejected:
    "That note couldn't be added. Use at most 500 characters, with something visible and no tabs.",
  unreadable:
    "TideGrid sent an answer this console can't read. Reload to check the note was added.",
  unreachable: "The note wasn't sent. Check your connection, then add it again.",
  unavailable: "TideGrid isn't responding right now. Add the note again in a moment.",
  key_reused: "That note changed while it was being sent. Add it again.",
};

function NoteForm({
  tenantId,
  tenantName,
  bookingId,
  onAdded,
}: {
  tenantId: string;
  tenantName: string;
  bookingId: string;
  onAdded: (note: BookingNote) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [said, setSaid] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  /** One key per note: kept when the same note is sent again after a failure. */
  const key = useRef<{ body: string; key: string } | null>(null);
  const live = useRef(true);
  const inputId = useId();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const trimmed = body.trim();
  const left = noteLimit - noteLength(body);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!trimmed) {
      setProblem("Write the note first.");
      field.current?.focus();
      return;
    }
    if (left < 0) {
      setProblem(`Shorten the note to ${noteLimit} characters.`);
      field.current?.focus();
      return;
    }
    if (key.current?.body !== trimmed) key.current = { body: trimmed, key: newIdempotencyKey() };
    setBusy(true);
    setProblem(undefined);
    setSaid("Adding the note…");
    const result = await addNote(tenantId, bookingId, trimmed, key.current.key);
    if (!live.current) return;
    setBusy(false);
    if (result.kind === "added") {
      key.current = null;
      setBody("");
      setSaid("Note added.");
      onAdded(result.note);
      field.current?.focus();
      return;
    }
    if (result.reason === "key_reused") key.current = null;
    setSaid("");
    setProblem(noteProblems[result.reason]);
    field.current?.focus();
  };

  return (
    <form className="bd-notes__form tg-field" onSubmit={(e) => void submit(e)} noValidate>
      <label className="tg-field__label" htmlFor={inputId}>
        Add a note
      </label>
      <p className="tg-field__hint" id={`${inputId}-hint`}>
        Seen by owners and booking staff at {tenantName}, not finance. A note can't be edited or
        removed later.
      </p>
      <textarea
        ref={field}
        id={inputId}
        className="tg-field__input bd-notes__input"
        name="note"
        rows={3}
        value={body}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${inputId}-hint ${inputId}-count${problem ? ` ${inputId}-error` : ""}`}
        onChange={(e) => {
          setBody(e.target.value);
          if (problem) setProblem(undefined);
          if (said) setSaid("");
        }}
      />
      <div className="bd-notes__row">
        <p
          className={left < 0 ? "bd-notes__count bd-notes__count--over" : "bd-notes__count"}
          id={`${inputId}-count`}
        >
          {left < 0
            ? `${-left} ${-left === 1 ? "character" : "characters"} over the limit`
            : `${left} ${left === 1 ? "character" : "characters"} left`}
        </p>
        <Button type="submit" variant="primary" icon="plus" busy={busy} busyLabel="Adding…">
          Add note
        </Button>
      </div>
      {problem && (
        <p className="tg-field__error" id={`${inputId}-error`}>
          <Icon name="x-octagon" />
          <span>{problem}</span>
        </p>
      )}
      {/* Focus stays in the field, so the outcome is said here (WCAG 4.1.3). */}
      <p className="tg-visually-hidden" role="status">
        {problem ?? said}
      </p>
    </form>
  );
}
