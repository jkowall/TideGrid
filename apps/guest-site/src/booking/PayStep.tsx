import type { CheckoutSession } from "@tidegrid/contracts";
import { Button, Icon, Notice } from "@tidegrid/design-system/components";
import { formatMoney, formatTimeLeft } from "@tidegrid/design-system/format";
import type { Ref } from "react";
import type { TestPaymentOutcome } from "./api.ts";
import { deadlineText, heldThing, type Trouble } from "./model.ts";

export type PayBusy = TestPaymentOutcome | "cancel";

/**
 * Step 3: the demo's test payment. It says plainly that no real card is
 * charged. The two buttons only ask the test provider to settle the payment;
 * the next screen waits for the checkout's own state, which only a verified
 * provider event can change.
 */
export function PayStep({
  session,
  timeZone,
  charter,
  now,
  busy,
  trouble,
  priceChange,
  onPay,
  onCancel,
  headingRef,
}: {
  session: CheckoutSession;
  timeZone: string;
  /** A private charter holds the whole boat; shared trips hold seats. */
  charter: boolean;
  now: number;
  busy: PayBusy | null;
  trouble: Trouble | null;
  /** Set when this checkout's total differs from the one the guest last saw. */
  priceChange: string | null;
  onPay: (outcome: TestPaymentOutcome) => void;
  onCancel: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const working = busy !== null;
  const left = Date.parse(session.expiresAt) - now;
  return (
    <div className="booking-step">
      <h2 id="booking-step-title" className="booking-step__title" ref={headingRef} tabIndex={-1}>
        Payment
      </h2>

      <Notice tone="info" title="This is a demo test payment" announce="none">
        <p>
          No real card is charged and no money moves. Choose how the test payment ends: it succeeds,
          or the card is declined.
        </p>
      </Notice>

      {priceChange && (
        <Notice tone="warning" title="The price changed" announce="none">
          <p>{priceChange}</p>
        </Notice>
      )}

      <section className="booking-pay" aria-labelledby="booking-pay-amount">
        <p className="booking-pay__label" id="booking-pay-amount">
          Amount to pay
        </p>
        <p className="booking-pay__amount">
          {formatMoney(session.amount)} <span className="booking-pay__currency">USD</span>
        </p>
        <p className="booking-pay__hold">
          <Icon name="hourglass" />
          <span>
            {left > 0
              ? `${charter ? "The boat is" : "Your seats are"} held for you until ${deadlineText(session.expiresAt, timeZone)}, ${formatTimeLeft(left)} from now.`
              : "The hold has run out. The page is checking what happened."}
          </span>
        </p>
        <div className="booking-pay__actions">
          <Button
            variant="primary"
            icon="credit-card"
            busy={busy === "succeed"}
            busyLabel="Paying…"
            disabled={working && busy !== "succeed"}
            onClick={() => onPay("succeed")}
          >
            Simulate successful payment
          </Button>
          <Button
            icon="x-octagon"
            busy={busy === "fail"}
            busyLabel="Declining…"
            disabled={working && busy !== "fail"}
            onClick={() => onPay("fail")}
          >
            Simulate declined payment
          </Button>
        </div>
      </section>

      {trouble?.notice && (
        <Notice tone="error" title={trouble.notice.title}>
          <p>{trouble.notice.body}</p>
        </Notice>
      )}

      <div className="booking-actions booking-actions--quiet">
        <Button
          variant="ghost"
          icon="arrow-left"
          busy={busy === "cancel"}
          busyLabel="Canceling…"
          disabled={working && busy !== "cancel"}
          onClick={onCancel}
        >
          Cancel checkout
        </Button>
        <p className="booking-actions__note">
          Canceling releases {heldThing(charter)} at once. You can change your party and start
          again.
        </p>
      </div>
    </div>
  );
}
