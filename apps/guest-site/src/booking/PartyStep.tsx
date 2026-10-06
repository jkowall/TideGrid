import type { TripOffer } from "@tidegrid/contracts";
import { Button, Icon, Notice, QuantityField } from "@tidegrid/design-system/components";
import { formatMoney } from "@tidegrid/design-system/format";
import type { ReactNode, Ref } from "react";
import {
  addOnHint,
  addOnLimit,
  eachPrice,
  feeText,
  fitAddOns,
  guests,
  isCharter,
  type PartyLimits,
  partySize,
  type Selection,
  type Trouble,
  taxText,
} from "./model.ts";
import { PolicySummary } from "./Policy.tsx";

function limitText(offer: TripOffer, limits: PartyLimits): string {
  const most = offer.product.maxPartySize;
  const range = limits.min > 1 ? `${limits.min} to ${most}` : `up to ${most}`;
  const seats =
    limits.seatsLeft === null
      ? ""
      : ` ${limits.seatsLeft} ${limits.seatsLeft === 1 ? "seat is" : "seats are"} left.`;
  return isCharter(offer)
    ? `The boat takes ${range} guests.`
    : `Book ${range} guests at a time. Each ticket is one guest.${seats}`;
}

/**
 * Step 1: who is coming and what extras they want. Prices here are the
 * offer's unit prices; the server prices the whole party on the next step.
 */
export function PartyStep({
  offer,
  limits,
  selection,
  onSelection,
  trouble,
  notice,
  busy,
  now,
  onContinue,
  onReloadOptions,
  headingRef,
  partyFieldRef,
}: {
  offer: TripOffer;
  limits: PartyLimits;
  selection: Selection;
  onSelection: (next: Selection) => void;
  trouble: Trouble | null;
  /** A notice carried in from elsewhere, such as a canceled checkout. */
  notice: ReactNode;
  busy: boolean;
  now: number;
  onContinue: () => void;
  onReloadOptions: () => void;
  headingRef: Ref<HTMLHeadingElement>;
  /** The first count, which takes focus when the party needs attention. */
  partyFieldRef: Ref<HTMLInputElement>;
}) {
  const charter = isCharter(offer);
  const size = partySize(offer, selection);
  const room = Math.max(0, limits.max - size);
  const partyError = trouble?.party;
  const tax = taxText(offer);

  const setTicket = (code: string, n: number) =>
    onSelection(fitAddOns(offer, { ...selection, tickets: { ...selection.tickets, [code]: n } }));
  const setGuests = (n: number) => onSelection(fitAddOns(offer, { ...selection, guests: n }));
  const setAddOn = (code: string, n: number) =>
    onSelection({ ...selection, addOns: { ...selection.addOns, [code]: n } });

  return (
    <form
      className="booking-step"
      aria-labelledby="booking-step-title"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onContinue();
      }}
    >
      <h2 id="booking-step-title" className="booking-step__title" ref={headingRef} tabIndex={-1}>
        {charter ? "Your group" : "Who's coming"}
      </h2>
      {notice}

      <fieldset
        className="booking-group"
        aria-describedby={partyError ? "booking-party-error" : undefined}
      >
        <legend className="booking-group__legend">{charter ? "Guests aboard" : "Tickets"}</legend>
        <p className="booking-group__hint">{limitText(offer, limits)}</p>
        {charter && offer.charter ? (
          <>
            <p className="booking-charter">
              <span>{offer.charter.name}</span>
              <strong>{formatMoney(offer.charter.amount)}</strong>
            </p>
            <QuantityField
              ref={partyFieldRef}
              label="Guests"
              hint="The charter price stays the same for any number of guests."
              value={selection.guests}
              min={limits.min}
              max={limits.max}
              onChange={setGuests}
              decrementLabel="Remove a guest"
              incrementLabel="Add a guest"
              describe={guests}
              disabled={busy}
            />
          </>
        ) : (
          offer.tickets.map((ticket, index) => {
            const count = selection.tickets[ticket.code] ?? 0;
            return (
              <QuantityField
                key={ticket.code}
                {...(index === 0 ? { ref: partyFieldRef } : {})}
                label={ticket.name}
                hint={eachPrice(ticket.unitAmount)}
                value={count}
                max={count + room}
                onChange={(n) => setTicket(ticket.code, n)}
                decrementLabel={`Remove one ${ticket.name} ticket`}
                incrementLabel={`Add one ${ticket.name} ticket`}
                describe={(n) => `${ticket.name}: ${n}. ${guests(size - count + n)} in all.`}
                disabled={busy}
              />
            );
          })
        )}
        {!charter && (
          <p className="booking-group__total" aria-hidden="true">
            {guests(size)}
          </p>
        )}
        {partyError && (
          <p className="tg-field__error" id="booking-party-error">
            <Icon name="x-octagon" />
            <span>{partyError}</span>
          </p>
        )}
      </fieldset>

      {offer.addOns.length > 0 && (
        <fieldset className="booking-group">
          <legend className="booking-group__legend">
            Extras <span className="booking-group__optional">(optional)</span>
          </legend>
          {offer.addOns.map((addOn) => (
            <QuantityField
              key={addOn.code}
              label={addOn.name}
              hint={addOnHint(addOn)}
              value={selection.addOns[addOn.code] ?? 0}
              max={addOnLimit(addOn, size)}
              onChange={(n) => setAddOn(addOn.code, n)}
              decrementLabel={`Remove one ${addOn.name}`}
              incrementLabel={`Add one ${addOn.name}`}
              error={trouble?.addOns?.[addOn.code]}
              disabled={busy}
            />
          ))}
        </fieldset>
      )}

      {(offer.fees.length > 0 || tax) && (
        <section className="booking-notes" aria-labelledby="booking-fees-title">
          <h3 id="booking-fees-title" className="booking-section-title">
            Fees and taxes
          </h3>
          <ul>
            {offer.fees.map((fee) => (
              <li key={fee.code}>{feeText(fee)}</li>
            ))}
            {tax && <li>{tax}</li>}
          </ul>
          <p>Your full price, with every fee and tax, comes next.</p>
        </section>
      )}

      <PolicySummary policy={offer.policy} trip={offer.trip} now={now} />

      {trouble?.stale && (
        <Notice
          tone="warning"
          title="This trip's options have changed"
          actions={
            <Button icon="refresh" onClick={onReloadOptions}>
              Show the new options
            </Button>
          }
        >
          <p>A ticket type or extra on this page is no longer offered. Load the current options.</p>
        </Notice>
      )}
      {trouble?.notice && (
        <Notice tone="error" title={trouble.notice.title}>
          <p>{trouble.notice.body}</p>
        </Notice>
      )}

      <div className="booking-actions">
        <Button
          type="submit"
          variant="primary"
          icon="chevron-right"
          iconPosition="end"
          busy={busy}
          busyLabel="Getting your price…"
        >
          Continue
        </Button>
      </div>
    </form>
  );
}
