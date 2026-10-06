import type { Quote, TripOffer } from "@tidegrid/contracts";
import {
  Button,
  CheckboxField,
  Icon,
  Ledger,
  Notice,
  Skeleton,
  TextField,
} from "@tidegrid/design-system/components";
import { formatTimeLeft } from "@tidegrid/design-system/format";
import type { Ref } from "react";
import { deadlineText, isCharter, quoteRows, type Trouble } from "./model.ts";
import { PolicySummary } from "./Policy.tsx";

export interface BookerDraft {
  name: string;
  email: string;
}

export interface DetailsErrors {
  name?: string | undefined;
  email?: string | undefined;
  policy?: string | undefined;
}

export type DetailsBusy = "checkout" | "refresh" | "promo" | "restore";

/**
 * Step 2: the priced quote, a promotion code, the booker's name and email,
 * and the policy to accept. The one primary action starts the checkout, or
 * gets a new price once this one has expired.
 */
export function DetailsStep({
  offer,
  quote,
  now,
  busy,
  trouble,
  promoDraft,
  onPromoDraft,
  onApplyPromo,
  onRemovePromo,
  booker,
  onBooker,
  errors,
  accepted,
  onAccept,
  inDoubt,
  onContinue,
  onRefresh,
  onChangeParty,
  headingRef,
  fieldRefs,
}: {
  offer: TripOffer;
  /** Null while the page restores a quote after a reload. */
  quote: Quote | null;
  /** The server's time, as the page estimates it, so a device clock that is off can't expire a price. */
  now: number;
  busy: DetailsBusy | null;
  trouble: Trouble | null;
  promoDraft: string;
  onPromoDraft: (value: string) => void;
  onApplyPromo: () => void;
  onRemovePromo: () => void;
  booker: BookerDraft;
  onBooker: (next: BookerDraft) => void;
  errors: DetailsErrors;
  /** The policy version the guest accepted, if any. */
  accepted: number | null;
  onAccept: (version: number | null) => void;
  /** A checkout request got no answer: only the same request may be sent again. */
  inDoubt: boolean;
  onContinue: () => void;
  onRefresh: () => void;
  onChangeParty: () => void;
  headingRef: Ref<HTMLHeadingElement>;
  fieldRefs: {
    name: Ref<HTMLInputElement>;
    email: Ref<HTMLInputElement>;
    policy: Ref<HTMLInputElement>;
    promo: Ref<HTMLInputElement>;
    /** The applied code's line, which takes focus when a code is applied. */
    promoApplied: Ref<HTMLParagraphElement>;
  };
}) {
  const expired = quote ? now >= Date.parse(quote.expiresAt) : false;
  // While a checkout may exist, only the same request may go again, even for
  // an expired price: the server answers it either way.
  const reprice = expired && !inDoubt;
  const applied = quote?.promotion?.code ?? null;
  const working = busy !== null;
  const policy = quote?.policy ?? offer.policy;

  return (
    <div className="booking-step">
      <h2 id="booking-step-title" className="booking-step__title" ref={headingRef} tabIndex={-1}>
        Your details
      </h2>

      <section className="booking-price" aria-labelledby="booking-price-title" aria-busy={working}>
        <h3 id="booking-price-title" className="booking-section-title">
          Price
        </h3>
        {quote ? (
          <>
            <Ledger caption="Price in US dollars" hideCaption rows={quoteRows(quote)} />
            {expired ? (
              !inDoubt && (
                <Notice tone="warning" title="This price has expired" announce="status">
                  <p>Prices are held for 30 minutes. Get the current price to continue.</p>
                </Notice>
              )
            ) : (
              <p className="booking-price__expiry">
                <Icon name="clock" />
                <span>
                  This price is good until{" "}
                  {deadlineText(quote.expiresAt, quote.trip.timeZone, new Date(now))},{" "}
                  {formatTimeLeft(Date.parse(quote.expiresAt) - now)} from now.{" "}
                  {isCharter(offer) ? "The boat is" : "Seats are"} held for you once you continue to
                  payment.
                </span>
              </p>
            )}
          </>
        ) : (
          <div className="booking-price__loading">
            <p className="tg-muted">Getting your price…</p>
            <Skeleton width="100%" height="9rem" />
          </div>
        )}

        <form
          className="booking-promo"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onApplyPromo();
          }}
        >
          {applied ? (
            <div className="booking-promo__applied">
              <p ref={fieldRefs.promoApplied} tabIndex={-1}>
                <Icon name="tag" />
                <span>
                  Code <strong>{applied}</strong> applied.
                </span>
              </p>
              <Button
                variant="ghost"
                onClick={onRemovePromo}
                busy={busy === "promo"}
                busyLabel="Removing…"
                // While a checkout may exist, a new price would start a second one.
                disabled={inDoubt || (working && busy !== "promo")}
              >
                Remove code
              </Button>
            </div>
          ) : (
            <div className="booking-promo__entry">
              <TextField
                ref={fieldRefs.promo}
                className="booking-promo__field"
                label="Promotion code (optional)"
                value={promoDraft}
                onChange={(event) => onPromoDraft(event.target.value)}
                error={trouble?.promo}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={40}
                disabled={!quote || inDoubt}
              />
              <Button
                type="submit"
                busy={busy === "promo"}
                busyLabel="Applying…"
                disabled={!quote || inDoubt || (working && busy !== "promo")}
              >
                Apply
              </Button>
            </div>
          )}
        </form>
      </section>

      <form
        className="booking-details"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (reprice) onRefresh();
          else onContinue();
        }}
      >
        <fieldset className="booking-group" disabled={inDoubt}>
          <legend className="booking-group__legend">Who's booking</legend>
          <p className="booking-group__hint">
            This is a demo: use a made-up name and email. Nothing is sent to them.
          </p>
          <TextField
            ref={fieldRefs.name}
            label="Full name"
            autoComplete="name"
            value={booker.name}
            onChange={(event) => onBooker({ ...booker, name: event.target.value })}
            error={errors.name}
            maxLength={120}
          />
          <TextField
            ref={fieldRefs.email}
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            value={booker.email}
            onChange={(event) => onBooker({ ...booker, email: event.target.value })}
            error={errors.email}
            maxLength={254}
          />
        </fieldset>

        <PolicySummary policy={policy} trip={offer.trip} now={now}>
          <CheckboxField
            ref={fieldRefs.policy}
            label="I accept this cancellation policy"
            hint={`Policy version ${policy.version}.`}
            checked={accepted === policy.version}
            onChange={(event) => onAccept(event.target.checked ? policy.version : null)}
            error={errors.policy}
            disabled={inDoubt}
          />
        </PolicySummary>

        {inDoubt && (
          <Notice tone="warning" title="We couldn't confirm that your checkout started">
            <p>
              The connection dropped before the payment step answered. Press Try again: it sends the
              same request, so you can't end up with two checkouts. Until it answers, the price, the
              code, and the party stay as they are.
            </p>
          </Notice>
        )}
        {/* While in doubt, a notice is about the last try, such as the rate limit. */}
        {trouble?.notice && (
          <Notice tone="error" title={trouble.notice.title}>
            <p>{trouble.notice.body}</p>
          </Notice>
        )}

        <div className="booking-actions">
          <Button
            type="submit"
            variant="primary"
            icon={reprice ? "refresh" : "lock"}
            busy={busy === "checkout" || busy === "refresh"}
            busyLabel={busy === "refresh" ? "Getting the current price…" : "Starting checkout…"}
            disabled={!quote || (working && busy !== "checkout" && busy !== "refresh")}
          >
            {reprice ? "Get the current price" : inDoubt ? "Try again" : "Continue to payment"}
          </Button>
          <Button
            variant="ghost"
            icon="arrow-left"
            onClick={onChangeParty}
            disabled={working || inDoubt}
          >
            Change party or extras
          </Button>
        </div>
      </form>
    </div>
  );
}
