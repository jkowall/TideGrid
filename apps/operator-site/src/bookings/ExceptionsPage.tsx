import type { FinalizationException, Membership } from "@tidegrid/contracts";
import {
  Button,
  EmptyState,
  Icon,
  Notice,
  Skeleton,
  StatusBadge,
} from "@tidegrid/design-system/components";
import { formatDate, formatMoney, formatTripTime } from "@tidegrid/design-system/format";
import { useEffect, useRef, useState } from "react";
import type { ReadFailure } from "../http.ts";
import { ConsoleLink } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { canSeeGuests, roleNames } from "../roles.ts";
import { loadExceptions, type ExceptionsPage as Page } from "./api.ts";
import { bookingsHref, exceptionRefund, exceptionTitle, guestsText, instantText } from "./model.ts";
import { ReadFailed } from "./States.tsx";

/**
 * Payments that arrived but could not become bookings (G2.12b): what
 * happened, when, the amount, and the refund, newest first. This is what an
 * operator follows up on. Owners and booking staff also see who paid, so they
 * can reach the guest; finance sees the money without the person.
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
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    void loadExceptions(tenantId, {}, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
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
  }, [tenantId, attempt]);

  const loadOlder = () => {
    if (load.kind !== "ready" || !load.page.nextBefore) return;
    const before = load.page.nextBefore;
    setLoad({ ...load, more: "loading" });
    void loadExceptions(tenantId, { before }).then((result) => {
      setLoad((current) => {
        if (current.kind !== "ready" || current.page.nextBefore !== before) return current;
        if (result.kind !== "ok") return { ...current, more: "failed" };
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

  const exceptions = load.kind === "ready" ? load.page.exceptions : [];
  return (
    <>
      <PageHeader eyebrow={tenantName} title="Payment exceptions" focusHeading={focusHeading} />
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
              Guests' names and contact details aren't shown to your role, {roleNames[role]}.
            </span>
          </p>
        )}
        <p className="tg-visually-hidden" role="status">
          {load.kind === "loading"
            ? "Loading payment exceptions…"
            : load.kind === "ready"
              ? exceptions.length === 0
                ? "No payment exceptions."
                : `${exceptions.length === 1 ? "1 payment exception" : `${exceptions.length} payment exceptions`}${load.page.nextBefore ? " shown, with older ones to load" : ""}.`
              : ""}
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
            <EmptyState icon="check-circle" title="No payment exceptions">
              <p>
                Every payment {tenantName} received became a booking. A payment that arrives too
                late, or doesn't match its checkout, shows here for follow-up.
              </p>
            </EmptyState>
          ) : (
            <ul className="ex-list">
              {exceptions.map((e) => (
                <ExceptionItem key={e.id} exception={e} seesGuests={seesGuests} />
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

function ExceptionItem({
  exception: e,
  seesGuests,
}: {
  exception: FinalizationException;
  seesGuests: boolean;
}) {
  const refund = exceptionRefund(e);
  const zone = e.trip.timeZone;
  const time = formatTripTime(e.trip.localStartTime, e.trip.startsAt, zone);
  const mismatch = e.reason === "payment_mismatch";
  return (
    <li className="ex-item" data-tone={refund.tone}>
      <div className="ex-item__head">
        <h2 className="ex-item__title">{exceptionTitle(e.reason)}</h2>
        <StatusBadge tone={refund.tone} icon={refund.icon}>
          {refund.label}
        </StatusBadge>
      </div>
      <p className="ex-item__detail">{refund.detail}</p>
      <dl className="console-dl ex-item__facts">
        <dt>Trip</dt>
        <dd>
          {/* The trip's bookings, to see who has the seats now. */}
          <ConsoleLink href={bookingsHref(e.trip.localDate, e.trip.tripId)}>
            {e.trip.productName}, {formatDate(e.trip.localDate, "medium")}, {time}
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
            <span className="bd-code">{e.payment.providerReference}</span>
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
      </dl>
    </li>
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
