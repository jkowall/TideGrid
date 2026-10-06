import type { PolicyTerms, TripOffer } from "@tidegrid/contracts";
import { type ReactNode, useId } from "react";
import { policySummary } from "./model.ts";

/**
 * The product's cancellation policy: three short lines on the marina's clock,
 * and the operator's own words behind "Read the full policy". The operator's
 * text is shown as text, never as markup.
 */
export function PolicySummary({
  policy,
  trip,
  now,
  children,
}: {
  policy: PolicyTerms;
  trip: TripOffer["trip"];
  now: number;
  /** The acceptance checkbox, on the step where the guest accepts it. */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="booking-policy" aria-labelledby={id}>
      <h3 id={id} className="booking-section-title">
        Cancellation policy
      </h3>
      <ul className="booking-policy__summary">
        {policySummary(policy, trip, now).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <details className="booking-policy__full">
        <summary>Read the full policy</summary>
        <dl>
          <dt>Cancellations</dt>
          <dd>{policy.text.cancellation}</dd>
          <dt>Changing your trip</dt>
          <dd>{policy.text.reschedule}</dd>
          <dt>Missed trips</dt>
          <dd>{policy.text.noShow}</dd>
          <dt>If the operator cancels</dt>
          <dd>{policy.text.operatorCancellation}</dd>
          <dt>Weather</dt>
          <dd>{policy.text.weather}</dd>
        </dl>
      </details>
      {children}
    </section>
  );
}
