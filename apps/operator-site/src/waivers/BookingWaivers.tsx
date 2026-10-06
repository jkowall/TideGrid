import type { BookingWaivers, ParticipantWaiver, StaffRole } from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  Dialog,
  Notice,
  Skeleton,
  StatusBadge,
  TextField,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { instantText } from "../bookings/model.ts";
import type { ReadFailure } from "../http.ts";
import { documentHref, loadBookingWaivers, newResendKey, resendWaiver } from "./api.ts";
import {
  canSendWaivers,
  deliveryText,
  relationshipText,
  resendFailureText,
  resendState,
  signerText,
  waiverStatuses,
} from "./model.ts";
import "./waivers.css";

/**
 * A booking's waivers (G2.15), for its detail page: each named participant
 * with how their waiver stands, shown as an icon and a label, who signs, the
 * signature or the latest email, the signed PDF, and, for owners and booking
 * staff, sending the request again with a reason. Self-contained: it loads
 * its own data, so the page it sits on only places it. Render it only for
 * roles that see guests (owners and booking staff); the API refuses finance.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; waivers: BookingWaivers }
  | { kind: "failed"; reason: ReadFailure };

export function BookingWaiversCard({
  tenantId,
  bookingId,
  role,
  timeZone,
}: {
  tenantId: string;
  bookingId: string;
  role: StaffRole;
  /** The trip's zone: times show on the marina's clock. */
  timeZone: string;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [resending, setResending] = useState<ParticipantWaiver | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    void loadBookingWaivers(tenantId, bookingId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLoad(
        result.kind === "ok"
          ? { kind: "ready", waivers: result.value }
          : { kind: "failed", reason: result.reason },
      );
    });
    return () => controller.abort();
  }, [tenantId, bookingId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <section className="console-card wv-card" aria-labelledby="wv-booking-title">
      <h2 id="wv-booking-title">Waivers</h2>
      {load.kind === "loading" && (
        <div aria-busy="true">
          <p className="tg-visually-hidden" role="status">
            Loading waivers…
          </p>
          <div className="wv-skeleton" aria-hidden="true">
            <Skeleton width="60%" height="1rem" />
            <Skeleton width="100%" height="3.5rem" />
            <Skeleton width="100%" height="3.5rem" />
          </div>
        </div>
      )}
      {load.kind === "failed" && (
        <Notice
          tone="error"
          title="Waivers didn't load"
          actions={
            <Button icon="refresh" onClick={reload}>
              Try again
            </Button>
          }
        >
          {load.reason === "forbidden"
            ? "Your role can't see waivers."
            : "TideGrid isn't responding right now. Try again in a moment."}
        </Notice>
      )}
      {load.kind === "ready" && (
        <WaiverList
          waivers={load.waivers}
          tenantId={tenantId}
          role={role}
          timeZone={timeZone}
          onResend={(p) => {
            setSentTo(null);
            setResending(p);
          }}
        />
      )}
      {sentTo && (
        <Notice tone="success" title="Sent again">
          A new waiver email is on its way to {sentTo}. The earlier link stops working when it
          arrives.
        </Notice>
      )}
      {resending?.request && (
        <ResendDialog
          tenantId={tenantId}
          participant={resending}
          onClose={() => setResending(null)}
          onSent={() => {
            setSentTo(resending.request?.delivery?.recipient ?? "the guest");
            setResending(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

function WaiverList({
  waivers,
  tenantId,
  role,
  timeZone,
  onResend,
}: {
  waivers: BookingWaivers;
  tenantId: string;
  role: StaffRole;
  timeZone: string;
  onResend: (participant: ParticipantWaiver) => void;
}) {
  const signed = waivers.participants.filter((p) => p.status === "signed").length;
  const now = Date.now();
  if (!waivers.required && waivers.participants.every((p) => !p.request)) {
    return <p className="wv-muted">No waiver applies to this trip.</p>;
  }
  return (
    <>
      <p className="wv-summary">
        {waivers.participants.length === 0
          ? "Nobody is named yet. The guest names the party from the booking's link, and each person gets a waiver email as they are named."
          : `${signed} of ${waivers.participants.length} named ${
              waivers.participants.length === 1 ? "person has" : "people have"
            } signed.`}
        {waivers.unnamedPlaces > 0 &&
          ` ${waivers.unnamedPlaces} ${waivers.unnamedPlaces === 1 ? "place is" : "places are"} not named yet.`}
      </p>
      {waivers.participants.length > 0 && (
        <ul className="wv-list">
          {waivers.participants.map((p) => {
            const status = waiverStatuses[p.status];
            const delivery = deliveryText(p);
            const resend = resendState(p, now);
            const signedBy = p.request?.signed;
            return (
              <li key={p.participantId} className="wv-item">
                <div className="wv-item__head">
                  <span className="wv-item__name">
                    {p.name}
                    {p.minor && <span className="wv-tag">Minor</span>}
                  </span>
                  <StatusBadge tone={status.tone} icon={status.icon}>
                    {status.label}
                  </StatusBadge>
                </div>
                {p.request && (
                  <p className="wv-item__line">
                    {signerText(p)}. {p.request.templateName}, version {p.request.version}.
                  </p>
                )}
                {signedBy && (
                  <p className="wv-item__line">
                    Signed {instantText(signedBy.signedAt, timeZone)} by {signedBy.signerName}
                    {signedBy.relationship ? `, ${relationshipText(signedBy.relationship)}` : ""}.
                  </p>
                )}
                {!signedBy && delivery && <p className="wv-item__line wv-muted">{delivery}</p>}
                {p.status === "no_address" && (
                  <p className="wv-item__line wv-muted">
                    It goes out as soon as the booking has an address for{" "}
                    {p.request?.requiredSigner === "guardian" ? "their parent or guardian" : "them"}
                    .
                  </p>
                )}
                {(signedBy || (canSendWaivers(role) && resend.kind !== "none")) && (
                  <div className="wv-item__actions">
                    {signedBy && (
                      <ButtonLink
                        icon="receipt"
                        href={documentHref(tenantId, signedBy.evidenceId)}
                        download
                      >
                        Signed PDF <VisuallyHidden>for {p.name}</VisuallyHidden>
                      </ButtonLink>
                    )}
                    {canSendWaivers(role) && resend.kind === "ready" && (
                      <Button icon="mail" onClick={() => onResend(p)}>
                        Send again <VisuallyHidden>to {p.name}</VisuallyHidden>
                      </Button>
                    )}
                    {canSendWaivers(role) && resend.kind === "later" && (
                      <p className="wv-muted wv-item__line">
                        Can be sent again from {instantText(resend.at, timeZone)}.
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function ResendDialog({
  tenantId,
  participant,
  onClose,
  onSent,
}: {
  tenantId: string;
  participant: ParticipantWaiver;
  onClose: () => void;
  onSent: () => void;
}) {
  const [reason, setReason] = useState("The guest asked for the email again.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  // One key per resend; the same key again when this resend is retried.
  const key = useRef(newResendKey());
  const input = useRef<HTMLInputElement>(null);
  const requestId = participant.request?.id ?? "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setFieldError("Say why it is being sent again; the history records it");
      input.current?.focus();
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    const result = await resendWaiver(tenantId, requestId, trimmed, key.current);
    setBusy(false);
    if (result.kind === "sent") onSent();
    else setError(resendFailureText(result.reason));
  };

  return (
    <Dialog
      title={`Send ${participant.name}'s waiver again`}
      onClose={onClose}
      dismissible={!busy}
      initialFocus={input}
      footer={
        <>
          <Button variant="primary" type="submit" form="wv-resend" busy={busy} busyLabel="Sending…">
            Send again
          </Button>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <form id="wv-resend" className="wv-resend" noValidate onSubmit={(e) => void submit(e)}>
        <p>
          A new email with a new link goes to the address the booking has now
          {participant.request?.delivery ? ` (${participant.request.delivery.recipient})` : ""}. The
          earlier link stops working. A waiver can be sent five times in all.
        </p>
        <TextField
          ref={input}
          label="Reason"
          hint="Recorded in the booking's history"
          maxLength={500}
          value={reason}
          error={fieldError}
          onChange={(e) => setReason(e.currentTarget.value)}
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
