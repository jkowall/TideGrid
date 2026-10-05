import type { Membership, StaffTrip } from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  Dialog,
  Notice,
  StatusBadge,
  TextField,
} from "@tidegrid/design-system/components";
import { formatCutoff, formatDate } from "@tidegrid/design-system/format";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { changeSalesState, newIdempotencyKey } from "./api.ts";
import {
  type ActionFailure,
  type ActionKind,
  type AfterConflict,
  actionCopy,
  consequence,
  cutoffPassed,
  failureCopy,
  hasDeparted,
  reasonProblem,
  salesStates,
  tripStart,
} from "./model.ts";

/**
 * Confirms one sales-state change and asks for the reason the audit history
 * records. Every change goes through here; canceling is the danger kind,
 * because it is final. Render one per trip and change, keyed on both, so a
 * reason or idempotency key can never carry over to another trip.
 */
export function ActionDialog({
  membership,
  trip,
  kind,
  onClose,
  onDone,
  onStale,
}: {
  membership: Membership;
  trip: StaffTrip;
  kind: ActionKind;
  /** Closed without a change. */
  onClose: () => void;
  /**
   * The API made the change and returned the trip. `replayed`: the API
   * answered from its record of the same request sent earlier.
   */
  onDone: (trip: StaffTrip, replayed: boolean) => void;
  /** Reload the week after the trip turned out to have changed. */
  onStale: () => Promise<{ reloaded: boolean; trip?: StaffTrip | undefined }>;
}) {
  const copy = actionCopy[kind];
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ failure: ActionFailure; after: AfterConflict }>();
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const signIn = useRef<HTMLAnchorElement>(null);
  /** The key and body of the last change sent, so sending it again reuses the key. */
  const sent = useRef<{ key: string; body: string } | null>(null);
  const formId = useId();
  const explainId = useId();
  // After a conflict, the badge shows the state the trip is in now.
  const state = salesStates[failed?.after.current ?? trip.salesState];
  const problem = failed && failureCopy(failed.failure, trip, failed.after);
  const finished = problem !== undefined && !problem.retry;
  const now = new Date();
  const cutoff = formatCutoff(trip.salesCloseAt, trip);

  // When the change cannot be retried, the confirm button goes away; focus
  // moves to the way forward.
  useEffect(() => {
    if (finished) (signIn.current ?? back.current)?.focus();
  }, [finished]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || finished) return;
    const fieldProblem = reasonProblem(reason);
    if (fieldProblem) {
      setFieldError(fieldProblem);
      input.current?.focus();
      return;
    }
    setFieldError(undefined);
    const body = { to: copy.to, reason: reason.trim() };
    const text = JSON.stringify(body);
    // A new change gets a new key; the same change sent again keeps its key.
    if (sent.current?.body !== text) sent.current = { key: newIdempotencyKey(), body: text };
    const key = sent.current.key;
    setBusy(true);
    setFailed(undefined);
    const result = await changeSalesState(membership.tenantId, trip.tripId, body, key);
    if (result.kind === "ok") {
      setBusy(false);
      onDone(result.trip, result.replayed);
      return;
    }
    // The API refused the key for this body: the next try is a new request.
    if (result.failure.kind === "key_reused") sent.current = null;
    let after: AfterConflict = { reloaded: false };
    if (result.failure.kind === "conflict" || result.failure.kind === "not_found") {
      const stale = await onStale();
      after = stale.reloaded
        ? stale.trip
          ? { reloaded: true, current: stale.trip.salesState }
          : { reloaded: true }
        : { reloaded: false };
    }
    setBusy(false);
    setFailed({ failure: result.failure, after });
  };

  const footer = finished ? (
    problem.signIn ? (
      <>
        <ButtonLink ref={signIn} variant="primary" icon="arrow-left" href="/">
          Sign in again
        </ButtonLink>
        <Button onClick={onClose}>Back to calendar</Button>
      </>
    ) : (
      <Button ref={back} variant="primary" onClick={onClose}>
        Back to calendar
      </Button>
    )
  ) : (
    <>
      <Button
        type="submit"
        form={formId}
        variant={copy.danger ? "danger" : "primary"}
        icon={copy.icon}
        busy={busy}
        busyLabel={copy.busy}
      >
        {copy.confirm}
      </Button>
      <Button disabled={busy} onClick={onClose}>
        {copy.back}
      </Button>
    </>
  );

  const explanation = consequence(kind, {
    cutoff,
    cutoffPassed: cutoffPassed(trip, now),
    departed: hasDeparted(trip, now),
    blackedOut: trip.blackedOut,
  });

  return (
    <Dialog
      title={copy.title}
      tone={copy.danger ? "danger" : "default"}
      onClose={onClose}
      dismissible={!busy}
      initialFocus={input}
      describedBy={explainId}
      footer={footer}
      // The calendar puts focus back on this trip itself; see CalendarPage.
      restoreFocus={false}
      className="cal-dialog"
    >
      <div className="cal-dialog__trip">
        <p className="cal-dialog__name">{trip.productName}</p>
        <p className="cal-dialog__when">
          {formatDate(trip.localDate, "full")}, {tripStart(trip)}
        </p>
        <p className="cal-dialog__meta">
          {trip.boatName}. Booking cutoff {cutoff}.
        </p>
        <div className="cal-dialog__badges">
          <StatusBadge tone={state.tone} icon={state.icon}>
            {state.label}
          </StatusBadge>
          {trip.blackedOut && (
            <StatusBadge tone="info" icon="eye-off">
              Blacked out
            </StatusBadge>
          )}
        </div>
      </div>
      {copy.danger ? (
        <Notice tone="warning" title="This can't be undone" announce="none" id={explainId}>
          <p>{explanation}</p>
        </Notice>
      ) : (
        <p id={explainId}>{explanation}</p>
      )}
      <form id={formId} noValidate onSubmit={(e) => void submit(e)}>
        <TextField
          ref={input}
          label="Reason"
          hint="Saved in the audit history with your name."
          value={reason}
          maxLength={500}
          autoComplete="off"
          disabled={finished}
          error={fieldError}
          onChange={(e) => setReason(e.target.value)}
        />
      </form>
      {problem && (
        <Notice tone="error" title={problem.title}>
          <p>{problem.body}</p>
        </Notice>
      )}
    </Dialog>
  );
}
