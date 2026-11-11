import type { ManagedBooking, Participant } from "@tidegrid/contracts";
import {
  Button,
  CheckboxField,
  Notice,
  TextField,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { inviteParticipant, saveParticipant } from "./api.ts";
import {
  type FormErrors,
  formErrors,
  formOf,
  inputOf,
  namedText,
  type ParticipantForm,
  participantDetail,
  slotsOf,
} from "./model.ts";

/**
 * Who is coming (lane 1, G2.11c): one place per seat in the party. The guest
 * names each place and corrects it in place; a minor names a parent or
 * guardian, who signs for them once waivers exist. One place is edited at a
 * time, and its Save is the only primary action on the page while it is open.
 *
 * A named person with an email of their own, or a minor with a guardian, can
 * be sent a link to check their own details (W3-G2.11-rest). The email goes
 * to the address already saved for them, never one typed here.
 */
export function PartySection({
  booking,
  session,
  operator,
  onSaved,
  onEnded,
}: {
  booking: ManagedBooking;
  session: string;
  operator: string;
  /** The participant the API saved: shown at once, then the booking is read again. */
  onSaved: (participant: Participant) => Promise<void>;
  onEnded: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [inviting, setInviting] = useState<number | null>(null);
  const [invite, setInvite] = useState<{
    tone: "success" | "warning" | "error";
    text: string;
  } | null>(null);
  const { partySize, participants, places } = booking.participants;
  const slots = slotsOf(partySize, participants, places);
  const editable = booking.partyEditable;
  const rowButtons = useRef(new Map<number, HTMLButtonElement>());
  const returnTo = useRef<number | null>(null);

  // Back to the row's button when its form closes, so keyboard users keep their place.
  useEffect(() => {
    if (editing === null && returnTo.current !== null) {
      rowButtons.current.get(returnTo.current)?.focus();
      returnTo.current = null;
    }
  }, [editing]);

  return (
    <section className="manage-card" aria-labelledby="manage-party">
      <div className="manage-card__head">
        <h2 id="manage-party" className="booking-section-title">
          Who's coming
        </h2>
        <p className="manage-quiet">{namedText(partySize, participants)}</p>
      </div>
      {editable ? (
        <p>
          Add the name of each person in your party, so {operator} knows who's coming. A guest under
          18 needs a parent or guardian.
        </p>
      ) : (
        <p>
          {booking.state === "canceled"
            ? "This booking is canceled, so its party no longer changes."
            : "This trip has left, so its party no longer changes."}
        </p>
      )}
      {saved && editable && (
        <Notice tone="success" title="Saved">
          {saved}
        </Notice>
      )}
      {invite && editable && (
        <Notice
          tone={invite.tone}
          title={invite.tone === "success" ? "Link on its way" : "Link not sent"}
        >
          {invite.text}
        </Notice>
      )}
      <ol className="manage-party">
        {slots.map((slot) =>
          editing === slot.position ? (
            <li key={slot.position} className="manage-party__slot manage-party__slot--editing">
              <ParticipantEditor
                position={slot.position}
                initial={formOf(slot.participant)}
                session={session}
                isNew={slot.participant === null}
                onDone={async (participant) => {
                  returnTo.current = slot.position;
                  setEditing(null);
                  if (participant) {
                    setSaved(`${participant.name} is guest ${slot.position}.`);
                    await onSaved(participant);
                  }
                }}
                onEnded={onEnded}
              />
            </li>
          ) : (
            <li key={slot.position} className="manage-party__slot">
              <span className="manage-party__place" aria-hidden="true">
                {slot.position}
              </span>
              <div className="manage-party__who">
                <span className="manage-party__name">
                  <VisuallyHidden>Guest {slot.position}: </VisuallyHidden>
                  {slot.participant ? slot.participant.name : "Not named yet"}
                </span>
                {slot.participant && (
                  <span className="manage-quiet">{participantDetail(slot.participant)}</span>
                )}
              </div>
              {editable && (
                <div className="manage-party__actions">
                  <Button
                    ref={(node) => {
                      if (node) rowButtons.current.set(slot.position, node);
                      else rowButtons.current.delete(slot.position);
                    }}
                    variant="secondary"
                    icon={slot.participant ? "pencil" : "plus"}
                    disabled={editing !== null}
                    onClick={() => {
                      setSaved(null);
                      setInvite(null);
                      setEditing(slot.position);
                    }}
                  >
                    {slot.participant ? "Edit" : "Add"}
                    <VisuallyHidden> guest {slot.position}</VisuallyHidden>
                  </Button>
                  {slot.participant && invitable(slot.participant) && (
                    <Button
                      variant="ghost"
                      icon="mail"
                      busy={inviting === slot.position}
                      busyLabel="Sending…"
                      disabled={
                        editing !== null || (inviting !== null && inviting !== slot.position)
                      }
                      onClick={() => {
                        const participant = slot.participant;
                        if (!participant) return;
                        setSaved(null);
                        setInvite(null);
                        setInviting(slot.position);
                        void inviteParticipant(session, slot.position).then((result) => {
                          setInviting(null);
                          if (result.kind === "refused" && result.status === 401) {
                            onEnded();
                            return;
                          }
                          setInvite(inviteOutcome(participant, result));
                        });
                      }}
                    >
                      Send link
                      <VisuallyHidden> to guest {slot.position}</VisuallyHidden>
                    </Button>
                  )}
                </div>
              )}
            </li>
          ),
        )}
      </ol>
    </section>
  );
}

/** Whether someone can be sent their own link: an address of theirs, or their guardian's. */
function invitable(p: Participant): boolean {
  return p.isMinor ? p.guardian !== null : p.email !== null;
}

function inviteOutcome(
  p: Participant,
  result: Awaited<ReturnType<typeof inviteParticipant>>,
): { tone: "success" | "warning" | "error"; text: string } {
  if (result.kind === "ok") {
    return {
      tone: "success",
      text:
        result.value === "guardian"
          ? `We're emailing ${p.guardian?.name ?? "their parent or guardian"} a link to check ${p.name}'s details. It works once and lasts until the trip.`
          : `We're emailing ${p.name} a link to check their own details. It works once and lasts until the trip.`,
    };
  }
  if (result.kind === "refused") {
    switch (result.code) {
      case "invitation_limit_reached":
        return {
          tone: "warning",
          text: `${p.name} has had enough links for today. Try again tomorrow.`,
        };
      case "participant_no_email":
      case "participant_not_named":
        return { tone: "warning", text: `Add an email for ${p.name} first, then send the link.` };
      case "booking_canceled":
        return { tone: "warning", text: "This booking is canceled, so no link was sent." };
      case "trip_departed":
        return { tone: "warning", text: "This trip has left, so no link was sent." };
      case "place_removed":
        return { tone: "warning", text: "That place was given up, so no link was sent." };
      case "rate_limited":
        return { tone: "warning", text: "Too many tries. Wait a minute, then try again." };
    }
  }
  return {
    tone: "error",
    text:
      result.kind === "network"
        ? "We couldn't reach the booking site. Check your connection and try again."
        : "Something went wrong on our side. Try again in a moment.",
  };
}

function ParticipantEditor({
  position,
  initial,
  session,
  isNew,
  onDone,
  onEnded,
}: {
  position: number;
  initial: ParticipantForm;
  session: string;
  isNew: boolean;
  /** The saved name, or null when the guest closed the form without saving. */
  onDone: (participant: Participant | null) => Promise<void>;
  onEnded: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const guardianField = useRef<HTMLInputElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  const guardianEmailField = useRef<HTMLInputElement>(null);
  // One key per set of details; a retry after no answer sends the same request.
  const attempt = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => nameField.current?.focus(), []);

  const set = <K extends keyof ParticipantForm>(field: K, value: ParticipantForm[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = formErrors(form);
    setErrors(found);
    const first = (["name", "email", "guardianName", "guardianEmail"] as const).find(
      (k) => found[k],
    );
    if (first) {
      ({
        name: nameField,
        email: emailField,
        guardianName: guardianField,
        guardianEmail: guardianEmailField,
      })[first].current?.focus();
      return;
    }
    const input = inputOf(form);
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setTrouble(null);
    const result = await saveParticipant(session, position, input, attempt.current.key);
    setBusy(false);
    if (result.kind === "ok") {
      attempt.current = null;
      await onDone(result.value.participant);
      return;
    }
    if (result.kind === "refused") {
      attempt.current = null;
      if (result.status === 401) {
        onEnded();
        return;
      }
      if (result.status === 409 || result.status === 422) {
        setTrouble(
          result.code === "booking_canceled"
            ? "This booking is canceled, so its party no longer changes."
            : result.code === "trip_departed"
              ? "This trip has left, so its party no longer changes."
              : result.message || "This change can't be saved.",
        );
        return;
      }
      if (result.status === 400) {
        setTrouble("Check the details and try again.");
        return;
      }
    }
    setTrouble(
      result.kind === "network"
        ? "Not saved: we couldn't reach the booking site. Check your connection and try again."
        : "Not saved: something went wrong on our side. Try again in a moment.",
    );
  };

  return (
    <form className="manage-editor" noValidate onSubmit={(e) => void submit(e)}>
      <fieldset className="booking-group">
        <legend className="booking-group__legend">
          {isNew ? `Add guest ${position}` : `Edit guest ${position}`}
        </legend>
        {trouble && (
          <Notice tone="error" title="Not saved">
            {trouble}
          </Notice>
        )}
        <TextField
          ref={nameField}
          label="Full name"
          autoComplete="off"
          maxLength={120}
          value={form.name}
          error={errors.name}
          onChange={(e) => set("name", e.target.value)}
        />
        <CheckboxField
          label="Under 18 on the day of the trip"
          checked={form.isMinor}
          onChange={(e) => set("isMinor", e.target.checked)}
        />
        {form.isMinor && (
          <>
            <TextField
              ref={guardianField}
              label="Parent or guardian's full name"
              autoComplete="off"
              maxLength={120}
              value={form.guardianName}
              error={errors.guardianName}
              onChange={(e) => set("guardianName", e.target.value)}
            />
            <TextField
              ref={guardianEmailField}
              label="Parent or guardian's email"
              type="email"
              inputMode="email"
              autoComplete="off"
              maxLength={254}
              value={form.guardianEmail}
              error={errors.guardianEmail}
              onChange={(e) => set("guardianEmail", e.target.value)}
            />
          </>
        )}
        <TextField
          ref={emailField}
          label="Their email (optional)"
          hint="Only for messages about this trip, such as their own waiver."
          type="email"
          inputMode="email"
          autoComplete="off"
          maxLength={254}
          value={form.email}
          error={errors.email}
          onChange={(e) => set("email", e.target.value)}
        />
        <div className="booking-actions">
          <Button type="submit" variant="primary" icon="check" busy={busy} busyLabel="Saving…">
            Save guest {position}
          </Button>
          <Button icon="arrow-left" disabled={busy} onClick={() => void onDone(null)}>
            Not now
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
