import type { CheckoutPayment, CheckoutSession } from "@tidegrid/contracts";
import { Button, Icon, Notice } from "@tidegrid/design-system/components";
import { formatMoney, formatTimeLeft } from "@tidegrid/design-system/format";
import type { Ref } from "react";
import type { TestPaymentOutcome } from "./api.ts";
import { CardPayment } from "./CardPayment.tsx";
import { deadlineText, heldThing, type Trouble } from "./model.ts";
import type { CardOutcome, StripeLoader } from "./stripe-js.ts";

/** "card": the Stripe card form is confirming a payment. */
export type PayBusy = TestPaymentOutcome | "cancel" | "card";

/** The Stripe card form's wiring, from the page (W1-STRIPE-ELEMENT). */
export interface CardWiring {
  /** The checkout's capability secret, for the Bearer payment read. */
  secret: string;
  loader: StripeLoader;
  onPay: (confirm: () => Promise<CardOutcome>) => Promise<CardOutcome | null>;
  onEnded: () => void;
}

/**
 * Step 3: the payment. Under the fake provider, the demo's test payment: it
 * says plainly that no real card is charged, and the two buttons only ask the
 * test provider to settle the payment. Under Stripe, the card-only Payment
 * Element in Stripe's test mode (W1-STRIPE-ELEMENT). Either way the next
 * screen waits for the checkout's own state, which only a verified provider
 * event can change.
 */
export function PayStep({
  session,
  payment,
  card,
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
  /** What pays it: its provider picks the test controls or the card form. */
  payment: CheckoutPayment | null;
  card: CardWiring;
  timeZone: string;
  /** A private charter holds the whole boat; shared trips hold seats. */
  charter: boolean;
  /** The server's time, as the page estimates it. */
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
  const byCard = payment?.provider === "stripe";
  return (
    <div className="booking-step">
      <h2 id="booking-step-title" className="booking-step__title" ref={headingRef} tabIndex={-1}>
        Payment
      </h2>

      {byCard ? (
        <Notice tone="info" title="This is a test payment" announce="none">
          <p>
            The card form runs in Stripe's test mode, so no real card is charged and no money moves.
            Use a Stripe test card, such as 4242 4242 4242 4242 with any future date and any
            security code.
          </p>
        </Notice>
      ) : (
        <Notice tone="info" title="This is a demo test payment" announce="none">
          <p>
            No real card is charged and no money moves. Choose how the test payment ends: it
            succeeds, or the card is declined.
          </p>
        </Notice>
      )}

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
              ? `${charter ? "The boat is" : "Your seats are"} held for you until ${deadlineText(session.expiresAt, timeZone, new Date(now))}, ${formatTimeLeft(left)} from now.`
              : "The hold has run out. The page is checking what happened."}
          </span>
        </p>
        {byCard ? (
          <CardPayment
            sessionId={session.id}
            secret={card.secret}
            amount={session.amount}
            loader={card.loader}
            blocked={working && busy !== "card"}
            onPay={card.onPay}
            onEnded={card.onEnded}
          />
        ) : (
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
        )}
      </section>

      {trouble?.notice && (
        <Notice tone="error" title={trouble.notice.title}>
          <p>{trouble.notice.body}</p>
        </Notice>
      )}

      <div className="booking-actions booking-actions--quiet">
        <Button
          variant="ghost"
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
