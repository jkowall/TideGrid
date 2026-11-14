import type { ManagedBooking } from "@tidegrid/contracts";
import { Button, Notice, TextField } from "@tidegrid/design-system/components";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { changeBooker } from "./api.ts";
import { bookerErrors } from "./model.ts";

/**
 * The booker corrects their own name and email (W3-G2.11-rest), from the
 * booking page, before the trip leaves. A new email moves the booking's
 * emails there: links sent to the old address stop working, the old address
 * is told (without a link), and the new address gets a fresh link. This page
 * stays open. At most 3 corrections a day; the operator can always help.
 */
export function BookerSection({
  booking,
  session,
  operator,
  onChanged,
  onEnded,
}: {
  booking: ManagedBooking;
  session: string;
  operator: string;
  onChanged: (booking: ManagedBooking) => void;
  onEnded: () => void;
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

  if (!booking.partyEditable) return null;
  if (!editing) {
    return (
      <div className="manage-booker">
        {outcome && (
          <div ref={outcomeRef} tabIndex={-1} className="manage-done">
            <Notice tone="success" title="Your details are saved">
              {outcome}
            </Notice>
          </div>
        )}
        <div className="booking-actions">
          <Button
            ref={opener}
            variant="secondary"
            icon="pencil"
            onClick={() => {
              setOutcome(null);
              setEditing(true);
            }}
          >
            Change your name or email
          </Button>
        </div>
      </div>
    );
  }
  return (
    <BookerEditor
      booking={booking}
      session={session}
      operator={operator}
      onDone={(result) => {
        returnFocus.current = true;
        if (result) {
          onChanged(result.booking);
          setOutcome(
            result.emailChanged
              ? `We've emailed a new link to ${result.booking.booker.email}. Links sent to your old address no longer work, and we've told that address about the change.`
              : result.changed
                ? "Your name is updated. Nothing was emailed."
                : "Your details were already these. Nothing changed.",
          );
        }
        setEditing(false);
      }}
      onEnded={onEnded}
    />
  );
}

function BookerEditor({
  booking,
  session,
  operator,
  onDone,
  onEnded,
}: {
  booking: ManagedBooking;
  session: string;
  operator: string;
  onDone: (
    result: { booking: ManagedBooking; changed: boolean; emailChanged: boolean } | null,
  ) => void;
  onEnded: () => void;
}) {
  const [form, setForm] = useState({ name: booking.booker.name, email: booking.booker.email });
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<{ text: string; unknown: boolean } | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  // One key per set of details; a retry after no answer sends the same request.
  const attempt = useRef<{ body: string; key: string } | null>(null);

  // A save that answers after the editor closed (the booking was canceled
  // meanwhile, say) changes nothing on the page.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    nameField.current?.focus();
    return () => {
      live.current = false;
    };
  }, []);
  const refused = (text: string) => setTrouble({ text, unknown: false });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = bookerErrors(form);
    setErrors(found);
    if (found.name) {
      nameField.current?.focus();
      return;
    }
    if (found.email) {
      emailField.current?.focus();
      return;
    }
    const input = { name: form.name.trim(), email: form.email.trim().toLowerCase() };
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setTrouble(null);
    const result = await changeBooker(session, input, attempt.current.key);
    if (!live.current) return;
    setBusy(false);
    if (result.kind === "ok") {
      attempt.current = null;
      onDone(result.value);
      return;
    }
    if (result.kind === "refused") {
      // A refusal that may have saved nothing (the server's trouble, or a
      // short rate limit) keeps the key, so the same details sent again
      // are taken once, and the answer says what really happened.
      const retryable =
        result.status >= 500 ||
        (result.status === 429 && result.code !== "contact_change_limit_reached");
      if (!retryable) attempt.current = null;
      if (result.status === 401) {
        onEnded();
        return;
      }
      if (result.status === 409) {
        refused(
          result.code === "booking_canceled"
            ? "This booking is canceled, so its details no longer change."
            : result.code === "trip_departed"
              ? "This trip has left, so its details no longer change."
              : "Your details changed a moment ago. Reload the page to see them, then try again.",
        );
        return;
      }
      if (result.status === 429) {
        refused(
          result.code === "contact_change_limit_reached"
            ? `You've changed these details 3 times today. Contact ${operator} to change them again.`
            : "That was a lot of tries in a short time. Wait a minute, then try again.",
        );
        return;
      }
      if (result.status === 404) {
        refused(`This booking can't be changed here any more. Contact ${operator} for help.`);
        return;
      }
      if (result.status === 400 || result.status === 422) {
        refused("Check the details and try again.");
        return;
      }
    }
    // No answer, an unreadable one, or the server's trouble: the change may
    // have been saved. Sending the same details again uses the same key, so it
    // is taken once and the answer says what happened.
    setTrouble({
      unknown: true,
      text:
        result.kind === "network"
          ? "We couldn't reach the booking site, so we don't know whether your details changed. Check your connection, then save the same details again: they're changed only once."
          : "Something went wrong on our side, so we don't know whether your details changed. Save the same details again in a moment: they're changed only once.",
    });
  };

  const emailChanging =
    form.email.trim().toLowerCase() !== booking.booker.email.trim().toLowerCase();

  return (
    <form className="manage-editor" noValidate onSubmit={(e) => void submit(e)}>
      <fieldset className="booking-group">
        <legend className="booking-group__legend">Your name and email</legend>
        {trouble && (
          <Notice
            tone={trouble.unknown ? "warning" : "error"}
            title={trouble.unknown ? "Not confirmed" : "Not saved"}
          >
            {trouble.text}
          </Notice>
        )}
        <TextField
          ref={nameField}
          label="Your full name"
          autoComplete="name"
          maxLength={120}
          value={form.name}
          error={errors.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <TextField
          ref={emailField}
          label="Your email"
          hint={
            emailChanging
              ? "We'll send a new link to this address. Links sent to your old address will stop working, and we'll tell that address about the change."
              : "Emails about this booking go here."
          }
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={254}
          value={form.email}
          error={errors.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
        <div className="booking-actions">
          <Button type="submit" variant="primary" icon="check" busy={busy} busyLabel="Saving…">
            Save your details
          </Button>
          <Button icon="arrow-left" disabled={busy} onClick={() => onDone(null)}>
            Not now
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
