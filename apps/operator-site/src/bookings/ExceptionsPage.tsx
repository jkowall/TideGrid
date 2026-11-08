import type {
  ExceptionResolutionReason,
  FinalizationException,
  FinalizationExceptionResolution,
  FinalizationExceptionStatus,
  Membership,
} from "@tidegrid/contracts";
import {
  Button,
  EmptyState,
  Icon,
  Notice,
  SelectField,
  Skeleton,
  StatusBadge,
} from "@tidegrid/design-system/components";
import { formatMoney, formatTripTime, todayIn } from "@tidegrid/design-system/format";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { newIdempotencyKey } from "../calendar/api.ts";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { ConsoleLink } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canResolveExceptions, canSeeGuests, roleNames } from "../roles.ts";
import { loadExceptions, type ExceptionsPage as Page } from "./api.ts";
import { type ResolveFailure, resolveException } from "./exception-resolution-api.ts";
import { MaskedReference } from "./MaskedReference.tsx";
import {
  bookingsHref,
  dayText,
  exceptionRefund,
  exceptionTitle,
  guestsText,
  instantText,
} from "./model.ts";
import { canRetry, ReadFailed } from "./States.tsx";

/**
 * Payments that arrived but could not become bookings (G2.12b): what
 * happened, when, the amount, and the refund, newest first. This is what an
 * operator follows up on. Owners and booking staff also see who paid, so they
 * can reach the guest; finance sees the money without the person.
 *
 * W1-FIN-EXC: owners and booking staff mark an exception as followed up,
 * with a reason and, when they choose, a note. It then leaves the open list
 * and shows under Followed up, the history, with who did it and when. Finance
 * sees the history without the notes, which can name a guest, and marks
 * nothing. Marking changes no money, booking, or refund.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; page: Page; more: "idle" | "loading" | "failed" }
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

export function ExceptionsPage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName, role } = membership;
  const seesGuests = canSeeGuests(role);
  const resolves = canResolveExceptions(role);
  const [view, setView] = useState<FinalizationExceptionStatus>("open");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  /** What the last follow-up did, said once at the page's level. */
  const [said, setSaid] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  /** Try again went with its notice: the page's heading takes focus. */
  const focusHeadingOnLoad = useRef(false);
  /** Show older exceptions went with the last page: the first older one takes focus. */
  const focusExceptionId = useRef<string | null>(null);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    void loadExceptions(tenantId, { status: view }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      focusHeadingOnLoad.current = retry && (result.kind === "ok" || !canRetry(result.reason));
      if (result.kind === "ok") {
        setLoad({ kind: "ready", page: result.value, more: "idle" });
        return;
      }
      setLoad((current) => ({
        kind: "failed",
        reason: result.reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, attempt, view]);

  // Focus moves on only from a control that went away with the change, never
  // from where the person has moved it while the page loaded.
  useEffect(() => {
    if (load.kind === "loading") return;
    const toHeading = focusHeadingOnLoad.current;
    focusHeadingOnLoad.current = false;
    let first: string | null = null;
    if (load.kind === "ready") {
      first = focusExceptionId.current;
      focusExceptionId.current = null;
    }
    if ((!toHeading && first === null) || !focusIsLost()) return;
    const older = !toHeading && first ? document.getElementById(exceptionHeadingId(first)) : null;
    (older ?? heading.current)?.focus();
  }, [load]);

  const loadOlder = () => {
    if (load.kind !== "ready" || !load.page.nextBefore) return;
    const before = load.page.nextBefore;
    setLoad({ ...load, more: "loading" });
    void loadExceptions(tenantId, { status: view, before }).then((result) => {
      setLoad((current) => {
        if (current.kind !== "ready" || current.page.nextBefore !== before) return current;
        if (result.kind !== "ok") return { ...current, more: "failed" };
        // The button the person pressed goes with the last page; the first
        // older exception takes focus, so their place is kept.
        if (result.value.nextBefore === null) {
          focusExceptionId.current = result.value.exceptions[0]?.id ?? "";
        }
        return {
          kind: "ready",
          more: "idle",
          page: {
            exceptions: [...current.page.exceptions, ...result.value.exceptions],
            nextBefore: result.value.nextBefore,
          },
        };
      });
    });
  };

  /**
   * An exception just followed up leaves the open list. Focus goes to the
   * next exception's heading, or the one before, or the page's heading.
   */
  /** The exception after the one just followed up, to hand focus to. */
  const nextAfterResolved = useRef<string | null>(null);
  const resolved = (exception: FinalizationException) => {
    // From the page as it is now, not as it was when the save began: another
    // save, or older exceptions, may have landed while this one was pending.
    setLoad((current) => {
      if (current.kind !== "ready") return current;
      const list = current.page.exceptions;
      const at = list.findIndex((e) => e.id === exception.id);
      if (at < 0) return current;
      nextAfterResolved.current = (list[at + 1] ?? list[at - 1])?.id ?? null;
      return {
        ...current,
        page: { ...current.page, exceptions: list.filter((e) => e.id !== exception.id) },
      };
    });
    setSaid(
      `Marked as followed up: ${exceptionTitle(exception.reason)}. It's now under Followed up.`,
    );
    // Only when focus went away with the item, never from where the person
    // has moved it while the save was pending.
    requestAnimationFrame(() => {
      const next = nextAfterResolved.current;
      nextAfterResolved.current = null;
      if (!focusIsLost()) return;
      const target = next ? document.getElementById(exceptionHeadingId(next)) : null;
      (target ?? heading.current)?.focus();
    });
  };

  const exceptions = load.kind === "ready" ? load.page.exceptions : [];
  const noun = view === "open" ? "payment exception" : "followed-up exception";
  return (
    <>
      <PageHeader
        eyebrow={tenantName}
        title="Payment exceptions"
        focusHeading={focusHeading}
        headingRef={heading}
      />
      <div className="ex">
        <p className="ex-lede">
          Payments that arrived but couldn't become bookings. TideGrid refunds each one in full
          automatically, except a payment that didn't match its checkout, which needs a check with
          the payment provider.
        </p>
        {!seesGuests && (
          <p className="bk-note">
            <Icon name="eye-off" />
            <span>
              Guests' names and contact details, and follow-up notes, aren't shown to your role,{" "}
              {roleNames[role]}.
            </span>
          </p>
        )}
        <SelectField
          className="ex-view"
          label="Show"
          value={view}
          options={[
            { value: "open", label: "Open, to follow up" },
            { value: "resolved", label: "Followed up" },
          ]}
          onChange={(e) => {
            setSaid("");
            setView(e.target.value === "resolved" ? "resolved" : "open");
          }}
        />
        <p className="tg-visually-hidden" role="status">
          {said ||
            (load.kind === "loading"
              ? `Loading ${noun}s…`
              : load.kind === "ready"
                ? exceptions.length === 0
                  ? `No ${noun}s.`
                  : `${exceptions.length === 1 ? `1 ${noun}` : `${exceptions.length} ${noun}s`}${load.page.nextBefore ? " shown, with older ones to load" : ""}.`
                : "")}
        </p>
        {load.kind === "loading" && <ExceptionsSkeleton />}
        {load.kind === "failed" && (
          <ReadFailed
            className="bk-notice"
            reason={load.reason}
            noun="payment exceptions"
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={() => {
              retryRequested.current = true;
              setAttempt((n) => n + 1);
            }}
          />
        )}
        {load.kind === "ready" &&
          (exceptions.length === 0 ? (
            view === "open" ? (
              <EmptyState icon="check-circle" title="No payment exceptions to follow up">
                <p>
                  Nothing at {tenantName} is waiting for follow-up. A payment that arrives too late,
                  or doesn't match its checkout, shows here. Ones already followed up are under
                  Followed up.
                </p>
              </EmptyState>
            ) : (
              <EmptyState icon="check-circle" title="Nothing followed up yet">
                <p>
                  When someone at {tenantName} marks a payment exception as followed up, it shows
                  here with who did it and when.
                </p>
              </EmptyState>
            )
          ) : (
            <ul className="ex-list">
              {exceptions.map((e) => (
                <ExceptionItem
                  key={e.id}
                  exception={e}
                  seesGuests={seesGuests}
                  tenantId={tenantId}
                  resolves={resolves && view === "open"}
                  onResolved={resolved}
                />
              ))}
            </ul>
          ))}
        {load.kind === "ready" && load.page.nextBefore && (
          <div className="bk-more">
            {load.more === "failed" && (
              <Notice tone="error" className="bk-notice" title="Older exceptions didn't load">
                <p>Check your connection, then try again.</p>
              </Notice>
            )}
            <Button busy={load.more === "loading"} busyLabel="Loading older…" onClick={loadOlder}>
              {load.more === "failed" ? "Try again" : "Show older exceptions"}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

const exceptionHeadingId = (id: string) => `exception-${id}`;

function ExceptionItem({
  exception: e,
  seesGuests,
  tenantId,
  resolves,
  onResolved,
}: {
  exception: FinalizationException;
  seesGuests: boolean;
  tenantId: string;
  /** This role marks exceptions as followed up, and the item is open. */
  resolves: boolean;
  onResolved: (exception: FinalizationException) => void;
}) {
  const refund = exceptionRefund(e);
  const zone = e.trip.timeZone;
  const time = formatTripTime(e.trip.localStartTime, e.trip.startsAt, zone);
  const mismatch = e.reason === "payment_mismatch";
  return (
    <li className="ex-item" data-tone={refund.tone}>
      <div className="ex-item__head">
        <h2 className="ex-item__title" id={exceptionHeadingId(e.id)} tabIndex={-1}>
          {exceptionTitle(e.reason)}
        </h2>
        <StatusBadge tone={refund.tone} icon={refund.icon}>
          {refund.label}
        </StatusBadge>
      </div>
      <p className="ex-item__detail">{refund.detail}</p>
      <dl className="console-dl ex-item__facts">
        <dt>Trip</dt>
        <dd>
          {/* The trip's bookings, to see who has the seats now. */}
          <ConsoleLink
            href={bookingsHref(e.trip.localDate, e.trip.tripId)}
            className="tap-target ex-item__trip"
          >
            {e.trip.productName}, {dayText(e.trip.localDate, "medium", todayIn(zone))}, {time}
          </ConsoleLink>
        </dd>
        <dt>Party</dt>
        <dd>{guestsText(e.partySize)}</dd>
        <dt>Amount</dt>
        <dd className="bk-money">{formatMoney(e.amount)}</dd>
        {mismatch && e.payment.reportedAmount !== null && (
          <>
            <dt>Provider reported</dt>
            <dd className="bk-money">
              {e.payment.reportedCurrency && e.payment.reportedCurrency !== "USD"
                ? `${e.payment.reportedAmount} minor units of ${e.payment.reportedCurrency}`
                : formatMoney(e.payment.reportedAmount)}
            </dd>
          </>
        )}
        {e.reason === "no_capacity" && (
          <>
            <dt>Checkout ran out</dt>
            <dd>{instantText(e.checkout.expiresAt, zone)}</dd>
          </>
        )}
        <dt>Payment received</dt>
        <dd>{instantText(e.payment.receivedAt, zone)}</dd>
        <dt>Provider reference</dt>
        <dd>
          {e.payment.providerReference ? (
            <MaskedReference value={e.payment.providerReference} />
          ) : (
            "Not recorded"
          )}
        </dd>
        {seesGuests && e.booker && (
          <>
            <dt>Paid by</dt>
            <dd className="console-dl__wrap">
              {e.booker.name}
              <span className="bd-block">{e.booker.email}</span>
            </dd>
          </>
        )}
        {e.resolution && <ResolutionFacts resolution={e.resolution} zone={zone} />}
      </dl>
      {resolves &&
        !e.resolution &&
        (e.refund?.state === "requested" ? (
          <p className="ex-item__wait">
            You can mark this as followed up once the refund finishes.
          </p>
        ) : (
          <ResolveForm tenantId={tenantId} exception={e} onResolved={onResolved} />
        ))}
    </li>
  );
}

/** How staff can say they followed an exception up (W1-FIN-EXC). */
export const resolutionReasonLabels: Record<ExceptionResolutionReason, string> = {
  contacted_guest: "Contacted the guest",
  refunded_outside: "Refunded outside TideGrid",
  no_action_needed: "No action needed",
  other: "Other",
};

function ResolutionFacts({
  resolution: r,
  zone,
}: {
  resolution: FinalizationExceptionResolution;
  zone: string;
}) {
  return (
    <>
      <dt>Followed up</dt>
      <dd>{resolutionReasonLabels[r.reasonCode]}</dd>
      <dt>By</dt>
      <dd>
        {r.resolvedBy.name}, <time dateTime={r.resolvedAt}>{instantText(r.resolvedAt, zone)}</time>
      </dd>
      {r.note && (
        <>
          <dt>Note</dt>
          <dd className="console-dl__wrap ex-item__note">{r.note}</dd>
        </>
      )}
    </>
  );
}

export const resolutionNoteLimit = 500;

/**
 * One character outside the contract's invisibleCharacters (white space, C0
 * and C1 controls, and the Unicode spaces, joiners, marks, fillers, and
 * variation selectors), the set migrations 0008 and 0017 check too. Kept
 * here, as the console imports only types from the contracts package.
 */
export const invisibleCharacters =
  "\\s\\u0000-\\u001f\\u007f-\\u009f\\u00a0\\u00ad\\u115f\\u1160\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2064\\u206a-\\u206f\\u3000\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0";
const visibleCharacter = new RegExp(`[^${invisibleCharacters}]`, "u");

const resolveProblems: Record<ResolveFailure, string> = {
  signed_out: "You're signed out. Sign in again, then mark it as followed up.",
  forbidden: "Your role can't mark exceptions as followed up. Owners and booking staff can.",
  suspended: "While this operator is suspended, exceptions can't be marked as followed up.",
  no_access: "You no longer have access to this operator. Ask one of its owners.",
  not_found: "This exception isn't here any more. Reload the page.",
  rejected:
    "That couldn't be saved. Choose a reason, and keep the note to 500 characters with something visible and no tabs.",
  unreadable: "TideGrid sent an answer this console can't read. Reload to check it was saved.",
  unreachable: "It wasn't sent. Check your connection, then try again.",
  unavailable: "TideGrid isn't responding right now. Try again in a moment.",
  already_resolved: "Someone already marked this as followed up. Reload to see who.",
  refund_pending: "The refund is still in progress. Try again once it finishes.",
  key_reused: "That changed while it was being sent. Try again.",
};

function ResolveForm({
  tenantId,
  exception,
  onResolved,
}: {
  tenantId: string;
  exception: FinalizationException;
  onResolved: (exception: FinalizationException) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ExceptionResolutionReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [said, setSaid] = useState("");
  const toggle = useRef<HTMLButtonElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  /** One key per resolution: kept when the same one is sent again after a failure. */
  const key = useRef<{ request: string; key: string } | null>(null);
  const live = useRef(true);
  const id = useId();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) select.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <div className="ex-item__actions">
        <Button ref={toggle} icon="check-circle" onClick={() => setOpen(true)}>
          Mark as followed up
        </Button>
      </div>
    );
  }

  const trimmed = note.trim();
  const length = [...trimmed].length;
  const left = resolutionNoteLimit - length;
  const needsNote = reason === "other";
  /** The API wants one character that shows, as a booking note does. */
  const visible = visibleCharacter.test(trimmed);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (reason === "") {
      setProblem("Choose how you followed it up.");
      select.current?.focus();
      return;
    }
    if (needsNote && !visible) {
      setProblem("Add a note to say what happened.");
      field.current?.focus();
      return;
    }
    if (trimmed && !visible) {
      setProblem("Write something you can see in the note, or leave it empty.");
      field.current?.focus();
      return;
    }
    if (left < 0) {
      setProblem(`Shorten the note to ${resolutionNoteLimit} characters.`);
      field.current?.focus();
      return;
    }
    const input = { reasonCode: reason, note: trimmed ? trimmed : null };
    const request = JSON.stringify(input);
    if (key.current?.request !== request) key.current = { request, key: newIdempotencyKey() };
    setBusy(true);
    setProblem(undefined);
    setSaid("Saving…");
    const result = await resolveException(tenantId, exception.id, input, key.current.key);
    if (!live.current) return;
    setBusy(false);
    if (result.kind === "resolved") {
      key.current = null;
      onResolved({ ...exception, resolution: result.resolution });
      return;
    }
    if (result.reason === "key_reused") key.current = null;
    setSaid("");
    setProblem(resolveProblems[result.reason]);
    // The live region says the problem; focus moves to the reason only if it
    // is still in this form or went nowhere, never from another control.
    if (focusIsLost() || form.current?.contains(document.activeElement)) select.current?.focus();
  };

  return (
    <form ref={form} className="ex-resolve" onSubmit={(e) => void submit(e)} noValidate>
      <SelectField
        ref={select}
        label="How did you follow it up?"
        value={reason}
        options={[
          { value: "", label: "Choose a reason" },
          ...(Object.keys(resolutionReasonLabels) as ExceptionResolutionReason[]).map((r) => ({
            value: r,
            label: resolutionReasonLabels[r],
          })),
        ]}
        error={problem}
        onChange={(e) => {
          setReason(e.target.value as ExceptionResolutionReason | "");
          if (problem) setProblem(undefined);
        }}
      />
      <div className="tg-field">
        <label className="tg-field__label" htmlFor={`${id}-note`}>
          {needsNote ? "Note" : "Note (optional)"}
        </label>
        <p className="tg-field__hint" id={`${id}-hint`}>
          Seen by owners and booking staff, not finance. It can't be edited or removed later.
        </p>
        <textarea
          ref={field}
          id={`${id}-note`}
          className="tg-field__input ex-resolve__note"
          name="note"
          rows={3}
          value={note}
          aria-describedby={`${id}-hint ${id}-count`}
          onChange={(e) => {
            setNote(e.target.value);
            if (problem) setProblem(undefined);
          }}
        />
        <p
          className={left < 0 ? "bd-notes__count bd-notes__count--over" : "bd-notes__count"}
          id={`${id}-count`}
        >
          {left < 0
            ? `${-left} ${-left === 1 ? "character" : "characters"} over the limit`
            : `${left} ${left === 1 ? "character" : "characters"} left`}
        </p>
      </div>
      <p className="ex-resolve__fine">
        This records the follow-up only. It doesn't refund, rebook, or change any payment.
      </p>
      <div className="ex-item__actions">
        <Button type="submit" variant="primary" icon="check-circle" busy={busy} busyLabel="Saving…">
          Mark as followed up
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setProblem(undefined);
            setSaid("");
            requestAnimationFrame(() => toggle.current?.focus());
          }}
        >
          Cancel
        </Button>
      </div>
      <p className="tg-visually-hidden" role="status">
        {problem ?? said}
      </p>
    </form>
  );
}

function ExceptionsSkeleton() {
  return (
    <div className="ex-list ex-list--skeleton" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="ex-item">
          <Skeleton width="min(26rem, 85%)" height="1.5rem" />
          <Skeleton variant="text" width="min(32rem, 95%)" />
          <Skeleton variant="text" width="min(18rem, 60%)" />
        </div>
      ))}
    </div>
  );
}
