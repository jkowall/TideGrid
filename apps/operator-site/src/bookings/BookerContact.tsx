import { Button, Notice, TextField } from "@tidegrid/design-system/components";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { newIdempotencyKey } from "../calendar/api.ts";
import { bookerProblems, cleanBooker } from "../new-booking/model.ts";
import { type BookerFailure, correctBooker } from "./booker-api.ts";

/**
 * Correct the booker's name and email from the booking's Guest card
 * (W3-G2.11-rest). Owners and booking staff, on a confirmed booking whose trip
 * has not left; staff are not limited, so they can always restore a booking a
 * guest's leaked link let someone change. A new email moves the booking's
 * emails: the old address's links stop working, the old address is told
 * without a link, and the new one gets a fresh link.
 */

const problems: Record<BookerFailure, string> = {
  signed_out: "You're signed out. Sign in again, then save the details.",
  forbidden: "Your role can't change the guest's details. Owners and booking staff can.",
  suspended: "While this operator is suspended, bookings can't be changed.",
  no_access: "You no longer have access to this operator. Ask one of its owners.",
  not_found: "This booking isn't here any more, so nothing was changed.",
  rejected: "Those details can't be saved. Check the name and the email address.",
  unreadable:
    "TideGrid sent an answer this console can't read. Reload to check whether the details changed.",
  unreachable: "The details weren't sent. Check your connection, then save again.",
  unavailable: "TideGrid isn't responding right now. Save again in a moment.",
  key_reused: "The details changed while they were being sent. Save again.",
  booking_canceled: "This booking is canceled, so its details no longer change.",
  trip_departed: "This trip has left, so its details no longer change.",
  booking_changed:
    "Someone changed these details a moment ago. Reload the booking to see them, then try again.",
};

export function BookerContact({
  tenantId,
  bookingId,
  booker,
  editable,
  onSaved,
}: {
  tenantId: string;
  bookingId: string;
  booker: { name: string; email: string | null };
  /** Confirmed and not departed, for a role that may change it. */
  editable: boolean;
  onSaved: (booker: { name: string; email: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    if (outcome) outcomeRef.current?.focus();
    else opener.current?.focus();
  }, [editing, outcome]);

  return (
    <>
      <dl className="console-dl">
        <dt>Booked by</dt>
        <dd>{booker.name}</dd>
        <dt>Email</dt>
        <dd className="console-dl__wrap">{booker.email ?? "No email on file"}</dd>
      </dl>
      {outcome && !editing && (
        <div ref={outcomeRef} tabIndex={-1}>
          <Notice tone="success" title="Guest details saved">
            {outcome}
          </Notice>
        </div>
      )}
      {editable && !editing && (
        <div className="bd-actions">
          <Button
            ref={opener}
            icon="pencil"
            onClick={() => {
              setOutcome(null);
              setEditing(true);
            }}
          >
            Correct name or email
          </Button>
        </div>
      )}
      {editable && editing && (
        <BookerForm
          tenantId={tenantId}
          bookingId={bookingId}
          booker={booker}
          onDone={(saved) => {
            returnFocus.current = true;
            if (saved) {
              onSaved(saved.booker);
              setOutcome(
                saved.emailChanged
                  ? `Emails about this booking now go to ${saved.booker.email}. A new link went there; links sent to the old address no longer work${booker.email ? ", and the old address was told" : ""}.`
                  : saved.changed
                    ? "The name is updated. Nothing was emailed."
                    : "The details were already these. Nothing changed.",
              );
            }
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

function BookerForm({
  tenantId,
  bookingId,
  booker,
  onDone,
}: {
  tenantId: string;
  bookingId: string;
  booker: { name: string; email: string | null };
  onDone: (
    saved: {
      booker: { name: string; email: string };
      changed: boolean;
      emailChanged: boolean;
    } | null,
  ) => void;
}) {
  const [draft, setDraft] = useState({ name: booker.name, email: booker.email ?? "" });
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  /** One key per set of details: kept when the same details are sent again after a failure. */
  const key = useRef<{ body: string; key: string } | null>(null);
  const live = useRef(true);
  const legendId = useId();
  useEffect(() => {
    live.current = true;
    nameField.current?.focus();
    return () => {
      live.current = false;
    };
  }, []);

  const clean = cleanBooker(draft);
  const emailChanging = clean.email !== (booker.email ?? "");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const found = bookerProblems(draft);
    setErrors(found);
    if (found.name) {
      nameField.current?.focus();
      return;
    }
    if (found.email) {
      emailField.current?.focus();
      return;
    }
    const body = JSON.stringify(clean);
    if (key.current?.body !== body) key.current = { body, key: newIdempotencyKey() };
    setBusy(true);
    setProblem(null);
    const result = await correctBooker(tenantId, bookingId, clean, key.current.key);
    if (!live.current) return;
    setBusy(false);
    if (result.kind === "saved") {
      key.current = null;
      onDone({ booker: clean, changed: result.changed, emailChanged: result.emailChanged });
      return;
    }
    if (result.reason !== "unreachable" && result.reason !== "unavailable") key.current = null;
    setProblem(problems[result.reason]);
  };

  return (
    <form className="bd-booker-form" noValidate onSubmit={(e) => void submit(e)}>
      <fieldset aria-labelledby={legendId}>
        <legend id={legendId}>Correct the guest's details</legend>
        {problem && (
          <Notice tone="error" title="Not saved">
            {problem}
          </Notice>
        )}
        <TextField
          ref={nameField}
          label="Booker's name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          error={errors.name}
          autoComplete="off"
          maxLength={120}
        />
        <TextField
          ref={emailField}
          label="Booker's email"
          type="email"
          hint={
            emailChanging
              ? "The booking's emails will go here, with a new link. Links sent to the old address stop working, and the old address is told without a link."
              : "The booking's emails go here."
          }
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
          error={errors.email}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="bd-actions">
          <Button type="submit" variant="primary" icon="check" busy={busy} busyLabel="Saving…">
            Save details
          </Button>
          <Button disabled={busy} onClick={() => onDone(null)}>
            Keep as is
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
