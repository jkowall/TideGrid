import type { Membership, StaffTrip, TripSalesState } from "@tidegrid/contracts";
import { Button, Dialog, Notice, StatusBadge, TextField } from "@tidegrid/design-system/components";
import { formatClock, formatCutoff, formatDate } from "@tidegrid/design-system/format";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { changeSalesState, newIdempotencyKey } from "./api.ts";
import {
  type ActionFailure,
  type ActionKind,
  actionCopy,
  consequence,
  failureCopy,
  reasonProblem,
  salesStates,
} from "./model.ts";

/**
 * Confirms one sales-state change and asks for the reason the audit history
 * records. Every change goes through here; canceling is the danger kind,
 * because it is final.
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
  /** The API made the change and returned the trip as it is now. */
  onDone: (trip: StaffTrip) => void;
  /** Reload the week after the trip turned out to have changed; resolves to the trip if found. */
  onStale: () => Promise<StaffTrip | undefined>;
}) {
  const copy = actionCopy[kind];
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ failure: ActionFailure; current?: TripSalesState }>();
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  /** The key and body of the last change sent, so sending it again reuses the key. */
  const sent = useRef<{ key: string; body: string } | null>(null);
  const formId = useId();
  const explainId = useId();
  const state = salesStates[trip.salesState];
  const problem = failed && failureCopy(failed.failure, trip, failed.current);
  const finished = problem !== undefined && !problem.retry;

  // When the change cannot be retried, the confirm button goes away; focus
  // moves to the one button left.
  useEffect(() => {
    if (finished) back.current?.focus();
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
      onDone(result.trip);
      return;
    }
    if (result.failure.kind === "key_reused") sent.current = null;
    let current: TripSalesState | undefined;
    if (result.failure.kind === "conflict" || result.failure.kind === "not_found") {
      current = (await onStale())?.salesState;
    }
    setBusy(false);
    setFailed({ failure: result.failure, ...(current ? { current } : {}) });
  };

  const footer = finished ? (
    <Button ref={back} variant="primary" onClick={onClose}>
      Back to calendar
    </Button>
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

  return (
    <Dialog
      title={copy.title}
      tone={copy.danger ? "danger" : "default"}
      onClose={onClose}
      dismissible={!busy}
      initialFocus={input}
      describedBy={explainId}
      footer={footer}
      className="cal-dialog"
    >
      <div className="cal-dialog__trip">
        <p className="cal-dialog__name">{trip.productName}</p>
        <p className="cal-dialog__when">
          {formatDate(trip.localDate, "full")}, {formatClock(trip.localStartTime)}
        </p>
        <p className="cal-dialog__meta">
          {trip.boatName}. Booking cutoff {formatCutoff(trip.salesCloseAt, trip)}.
        </p>
        <StatusBadge tone={state.tone} icon={state.icon}>
          {state.label}
        </StatusBadge>
      </div>
      {copy.danger ? (
        <Notice tone="warning" title="This can't be undone" announce="none" id={explainId}>
          <p>{consequence(kind, formatCutoff(trip.salesCloseAt, trip))}</p>
        </Notice>
      ) : (
        <p id={explainId}>{consequence(kind, formatCutoff(trip.salesCloseAt, trip))}</p>
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
