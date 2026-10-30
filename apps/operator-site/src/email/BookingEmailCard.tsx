import type {
  BookingEmailResendKind,
  BookingEmailResendReason,
  BookingMessagesResponse,
  StaffRole,
} from "@tidegrid/contracts";
import {
  Button,
  Dialog,
  Notice,
  SelectField,
  Skeleton,
  StatusBadge,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { instantText } from "../bookings/model.ts";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { canResendEmail } from "../roles.ts";
import { loadBookingEmail, newResendKey, resendBookingEmail } from "./api.ts";
import {
  blockedText,
  failureText,
  isBookingEmail,
  kindNames,
  reasonOptions,
  resendFailureText,
  stateView,
  templateName,
  whenText,
} from "./model.ts";
import "./email.css";

/**
 * A booking's email (G2.16b), for its detail page: each email the booking
 * sent, oldest first, with what it was, its state as an icon and a label,
 * when, how many attempts, and any failure in plain words; whether this
 * environment sends email at all; and, for owners and booking staff, sending
 * the confirmation or the cancellation notice again with a reason.
 * Self-contained: it loads its own data, so the page only places it. Render
 * it only for roles that see guests; the API refuses finance.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; data: BookingMessagesResponse }
  | { kind: "failed"; reason: ReadFailure };

export function BookingEmailCard({
  tenantId,
  bookingId,
  role,
  timeZone,
  bookerEmail,
}: {
  tenantId: string;
  bookingId: string;
  role: StaffRole;
  /** The trip's zone: times show on the marina's clock. */
  timeZone: string;
  /** The booker's address from the booking already loaded, to read back. Never sent. */
  bookerEmail: string | null;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [sending, setSending] = useState<BookingEmailResendKind | null>(null);
  const [sent, setSent] = useState<{ kind: BookingEmailResendKind; n: number } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sentNotice = useRef<HTMLDivElement>(null);
  /** Try again was pressed on a failed read: where focus goes when it ends. */
  const retried = useRef(false);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    setBusy(true);
    void loadBookingEmail(tenantId, bookingId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLoad((current) =>
        result.kind === "ok"
          ? { kind: "ready", data: result.value }
          : current.kind === "ready" && retried.current === false
            ? current
            : { kind: "failed", reason: result.reason },
      );
      setBusy(false);
    });
    return () => controller.abort();
  }, [tenantId, bookingId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // Try again worked and its button is gone: the card's heading takes focus,
  // unless the person moved it elsewhere meanwhile. A layout effect, so a
  // click that lands before the commit's passive effects never races it.
  useLayoutEffect(() => {
    if (busy || !retried.current) return;
    retried.current = false;
    if (load.kind === "ready" && focusIsLost()) heading.current?.focus();
  }, [busy, load]);

  // A send went out: its notice takes focus, since the dialog and perhaps the
  // button that opened it are gone.
  useLayoutEffect(() => {
    if (sent) sentNotice.current?.focus();
  }, [sent]);

  // After a send, read again once the delivery job has had a moment, so the
  // row says the email went out rather than that it is queued.
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(reload, 3000);
    return () => clearTimeout(timer);
  }, [sent, reload]);

  const when = (iso: string) => instantText(iso, timeZone);
  const data = load.kind === "ready" ? load.data : null;
  const off = data?.emailDelivery === "off";
  const messages = data ? data.messages.filter(isBookingEmail) : [];
  const resend = data?.resend ?? null;
  const blocked = resend ? blockedText(resend, when) : null;

  return (
    <section className="console-card em-card" aria-labelledby="em-booking-title" aria-busy={busy}>
      <h2 id="em-booking-title" ref={heading} tabIndex={-1}>
        Email
      </h2>
      {load.kind === "loading" && (
        <div>
          <p className="tg-visually-hidden" role="status">
            Loading email…
          </p>
          <div className="em-skeleton" aria-hidden="true">
            <Skeleton width="60%" height="1rem" />
            <Skeleton width="100%" height="3.5rem" />
          </div>
        </div>
      )}
      {load.kind === "failed" && (
        <Notice
          tone="error"
          title="Email didn't load"
          actions={
            // Signed out, trying again meets the same answer: sign in first.
            load.reason === "signed_out" ? undefined : (
              <Button
                icon="refresh"
                busy={busy}
                busyLabel="Trying again…"
                onClick={() => {
                  retried.current = true;
                  reload();
                }}
              >
                Try again
              </Button>
            )
          }
        >
          {load.reason === "signed_out"
            ? "You're signed out. Sign in again to see this booking's email."
            : load.reason === "forbidden"
              ? "Your role can't see this booking's email."
              : "TideGrid isn't responding right now. Try again in a moment."}
        </Notice>
      )}
      {data && (
        <>
          {off && (
            <Notice tone="info" title="Email is off here" announce="none">
              This environment sends no email, so messages wait in the queue and no guest gets them.
              Nothing can be sent again here.
            </Notice>
          )}
          {messages.length === 0 ? (
            <p className="em-muted">No email for this booking yet.</p>
          ) : (
            <ul className="em-list">
              {messages.map((m) => {
                const state = stateView(m);
                const failure = failureText(m.failureCode, m.template);
                return (
                  <li key={m.id} className="em-item">
                    <div className="em-item__head">
                      <span className="em-item__name">
                        {templateName(m.template)}
                        {m.staffResend && (
                          <>
                            <VisuallyHidden>, </VisuallyHidden>
                            <span className="em-tag">Sent again by staff</span>
                          </>
                        )}
                      </span>
                      <StatusBadge tone={state.tone} icon={state.icon}>
                        {state.label}
                      </StatusBadge>
                    </div>
                    <p className="em-item__line">{whenText(m, when, off)}</p>
                    {failure && <p className="em-item__line em-muted">{failure}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {canResendEmail(role) && resend && !off && (
            <div className="em-resend">
              {resend.allowed && resend.kind ? (
                <>
                  <Button icon="mail" onClick={() => setSending(resend.kind)}>
                    Send the {kindNames[resend.kind]} again
                  </Button>
                  <p className="em-muted">
                    {resend.remaining} of 5 sends again left for this booking.
                  </p>
                </>
              ) : (
                blocked && <p className="em-muted">{blocked}</p>
              )}
            </div>
          )}
          {sent && (
            <div ref={sentNotice} tabIndex={-1} className="em-sent">
              {/* Queued, not delivered: the list says what the email service did with it. */}
              <Notice tone="success" title="Queued to send again">
                A new {kindNames[sent.kind]} is queued for{" "}
                <span className="em-address">{bookerEmail ?? "the guest"}</span>. The list above
                shows whether the email service took it.
              </Notice>
            </div>
          )}
        </>
      )}
      {sending && (
        <ResendDialog
          tenantId={tenantId}
          bookingId={bookingId}
          kind={sending}
          remaining={resend?.remaining ?? 0}
          bookerEmail={bookerEmail}
          onClose={() => setSending(null)}
          onSent={() => {
            setSent((current) => ({ kind: sending, n: (current?.n ?? 0) + 1 }));
            setSending(null);
            reload();
          }}
          // The API decided against this send: what the card offers may have
          // changed (a send that went through, a limit), so read it again.
          onDecided={reload}
        />
      )}
    </section>
  );
}

function ResendDialog({
  tenantId,
  bookingId,
  kind,
  remaining,
  bookerEmail,
  onClose,
  onSent,
  onDecided,
}: {
  tenantId: string;
  bookingId: string;
  kind: BookingEmailResendKind;
  remaining: number;
  bookerEmail: string | null;
  onClose: () => void;
  onSent: () => void;
  /** The API answered with a final refusal: the card reads again. */
  onDecided: () => void;
}) {
  const [reason, setReason] = useState<BookingEmailResendReason | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  // One key per send, bound to what it sends: the same key again when the
  // same send is retried after no answer; a new one when the reason changes
  // (the API would refuse the old key with another body) and after the API
  // decided, since a refusal is the stored answer for its key.
  const key = useRef<{ value: string; reason: BookingEmailResendReason } | null>(null);
  const select = useRef<HTMLSelectElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!reason) {
      setFieldError("Choose why it is being sent again; the history records it");
      select.current?.focus();
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    if (key.current?.reason !== reason) key.current = { value: newResendKey(), reason };
    const result = await resendBookingEmail(tenantId, bookingId, kind, reason, key.current.value);
    setBusy(false);
    if (result.kind === "sent") {
      onSent();
      return;
    }
    setError(resendFailureText(result.reason));
    if (result.final) {
      key.current = null;
      onDecided();
    }
  };

  return (
    <Dialog
      title={`Send the ${kindNames[kind]} again`}
      onClose={onClose}
      dismissible={!busy}
      initialFocus={select}
      footer={
        <>
          <Button variant="primary" type="submit" form="em-resend" busy={busy} busyLabel="Sending…">
            Send again
          </Button>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <form id="em-resend" className="em-dialog" noValidate onSubmit={(e) => void submit(e)}>
        <p>
          A new email goes to{" "}
          {bookerEmail ? <strong className="em-address">{bookerEmail}</strong> : "the guest"}, the
          address on the booking. Read it back to the guest first: it can't be changed here.
        </p>
        <p>
          {kind === "confirmation"
            ? "It has the receipt, the trip, the policy, and a new booking link. Links in earlier emails stop working once TideGrid starts sending it, even if that send fails; the guest can still ask for a new link from one."
            : "It says the booking is canceled and what its refund is now."}{" "}
          {remaining === 1
            ? "This is the last send again for this booking."
            : `${remaining} sends again are left for this booking.`}
        </p>
        <SelectField
          ref={select}
          label="Reason"
          hint="Kept in the booking's audit history"
          value={reason}
          error={fieldError}
          options={[{ value: "", label: "Choose a reason" }, ...reasonOptions]}
          onChange={(e) => setReason(e.currentTarget.value as BookingEmailResendReason | "")}
        />
        {error && (
          <Notice tone="error" title="It wasn't sent">
            {error}
          </Notice>
        )}
      </form>
    </Dialog>
  );
}
