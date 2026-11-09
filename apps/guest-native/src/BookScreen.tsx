import type {
  AvailableTrip,
  CheckoutPayment,
  CheckoutSession,
  Quote,
  TripOffer,
} from "@tidegrid/contracts";
import { formatMoney, formatTimeLeft } from "@tidegrid/design-system/format";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, BackHandler, Pressable, Switch, Text, View } from "react-native";
import {
  type CheckoutBody,
  cancelCheckout,
  createQuote,
  getOffer,
  type OpenedSession,
  openCheckout,
  openFromCheckout,
  readCheckout,
  settleTestPayment,
  type TestPaymentOutcome,
} from "./booking-api.ts";
import {
  addOnHint,
  addOnLimit,
  afterSettle,
  bookerProblems,
  checkoutTrouble,
  deadlineText,
  eachPrice,
  finalStates,
  fitAddOns,
  guests,
  initialSelection,
  isCharter,
  mustResend,
  outcomeText,
  type PartyLimits,
  type PaymentDelivery,
  partyLimits,
  partyProblem,
  partySize,
  policySummary,
  pollDelay,
  quoteBody,
  quoteRows,
  quoteTrouble,
  type Selection,
  serverClock,
  stopText,
  type Trouble,
  tripWhen,
} from "./booking-model.ts";
import { outcomeUnknown } from "./http.ts";
import { CheckoutAttempt, CommandKey } from "./random.ts";
import {
  Body,
  Button,
  ErrorText,
  Field,
  Heading,
  ink,
  Loading,
  Notice,
  Screen,
  Stepper,
  styles,
} from "./ui.tsx";
import type { Endpoint } from "./variant.ts";

/**
 * Booking one trip: the party and extras, a price, the booker and the policy,
 * a hold with the test payment, and the outcome. The same API calls, in the
 * same order, as the guest web app's booking page. Secrets (the checkout
 * secret and the payment's client secret) stay in this screen's memory and
 * are never stored or logged.
 */

type NoticeTrouble = Extract<Trouble, { kind: "notice" }>;

type CheckoutFields = Omit<CheckoutBody, "checkoutSecret">;

/** After a payment was sent, how long an "expired" checkout is read again, as the web app does. */
const lateSuccessGraceMs = 30_000;

type Phase =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "stop"; stop: Extract<Trouble, { kind: "stop" }>["stop"] }
  | { kind: "party"; offer: TripOffer }
  | { kind: "review"; offer: TripOffer; quote: Quote }
  | {
      kind: "pay";
      offer: TripOffer;
      session: CheckoutSession;
      /** Null while the app reads where a checkout stands, before it can be paid. */
      payment: CheckoutPayment | null;
      secret: string;
    }
  | { kind: "outcome"; offer: TripOffer; session: CheckoutSession; secret: string };

export function BookScreen({
  endpoint,
  operator,
  color,
  trip,
  onClose,
  onBooked,
}: {
  endpoint: Endpoint;
  operator: string;
  color: string;
  trip: AvailableTrip;
  onClose: () => void;
  /** A booking session opened right after paying, for the app to keep and show. */
  onBooked: (session: OpenedSession) => Promise<void>;
}) {
  const [phase, setPhaseState] = useState<Phase>({ kind: "loading" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [partyText, setPartyText] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeTrouble | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  /** A checkout's answer never arrived: it may hold seats, so only the same request may follow. */
  const [inDoubt, setInDoubt] = useState(false);
  const [stalled, setStalled] = useState(false);
  /** What the screen is waiting on while it reads the checkout: the payment sent, or the hold's end. */
  const [waiting, setWaiting] = useState<string | null>(null);
  /** The server's clock as the app estimates it: holds and prices expire on its time. */
  const clock = useRef(serverClock);
  /**
   * Whether the test payment's event reached the booking. While it may not
   * have, the same payment must be sent again, even after the hold's end, and
   * the checkout is not canceled under it (see `PaymentDelivery`).
   */
  const delivery = useRef<PaymentDelivery>("none");
  const [resend, setResend] = useState(false);
  const setDelivery = (next: PaymentDelivery) => {
    delivery.current = next;
    setResend(mustResend(next));
  };
  const [now, setNow] = useState(Date.now());
  const quoteKey = useRef(new CommandKey());
  const attempt = useRef(new CheckoutAttempt());
  /** The details sent with the checkout in doubt; a retry sends exactly these. */
  const doubtedFields = useRef<CheckoutFields | null>(null);
  /** Whether a test payment was sent for the open checkout, so an early "expired" may still change. */
  const paymentSent = useRef(false);
  const alive = useRef(true);
  /**
   * Changes with every step, so an answer or a polling loop started for one
   * checkout never moves the screen once the guest has moved on.
   */
  const epoch = useRef(0);
  /**
   * Changes with every new polling loop, so only the newest loop reads. Kept
   * apart from `epoch`: a loop starting when the hold runs out must not drop
   * the answer of a payment still in flight for the same checkout.
   */
  const polls = useRef(0);
  /** One command at a time: a double tap sends nothing twice. */
  const lock = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const go = useCallback((next: Phase) => {
    epoch.current += 1;
    polls.current += 1;
    setBusy(null);
    setWaiting(null);
    setStalled(false);
    setPhaseState(next);
  }, []);

  /** Run one command at a time; `still()` says whether its answer may still change the screen. */
  const exclusive = async (label: string, run: (still: () => boolean) => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    const mine = epoch.current;
    setBusy(label);
    try {
      await run(() => alive.current && epoch.current === mine);
    } finally {
      lock.current = false;
      if (alive.current && epoch.current === mine) setBusy(null);
    }
  };

  const load = useCallback(() => {
    go({ kind: "loading" });
    const mine = epoch.current;
    void getOffer(endpoint, trip.tripId).then((r) => {
      if (!alive.current || epoch.current !== mine) return;
      if (r.kind === "ok") {
        setSelection(initialSelection(r.value, partyLimits(r.value, trip)));
        go({ kind: "party", offer: r.value });
      } else if (r.kind === "refused" && r.status === 404) {
        go({ kind: "stop", stop: "not_found" });
      } else if (r.kind === "refused" && r.code === "trip_not_bookable") {
        go({ kind: "stop", stop: "not_bookable" });
      } else go({ kind: "failed" });
    });
  }, [endpoint, trip, go]);
  useEffect(load, []);

  const apply = (trouble: Trouble, offer: TripOffer) => {
    switch (trouble.kind) {
      case "notice":
        setNotice(trouble);
        break;
      case "party":
        setPartyText(trouble.text);
        go({ kind: "party", offer });
        break;
      case "stop":
        go({ kind: "stop", stop: trouble.stop });
        break;
      case "requote":
        setNotice({
          kind: "notice",
          title: "That price is no longer available",
          body: "Check your party, then continue for a new price.",
        });
        go({ kind: "party", offer });
        break;
    }
  };

  // Party -> a price.
  const price = (offer: TripOffer, limits: PartyLimits) =>
    exclusive("quote", async (still) => {
      if (!selection) return;
      const problem = partyProblem(offer, selection, limits);
      setPartyText(problem);
      setNotice(null);
      if (problem) return;
      const body = quoteBody(offer, selection);
      const r = await createQuote(endpoint, body, quoteKey.current.for(JSON.stringify(body)));
      if (!still()) return;
      if (r.kind === "ok") {
        // An old answer to a retried key teaches nothing about the clock.
        if (!r.replayed) clock.current.learn(r.value.quotedAt);
        quoteKey.current.done();
        setShowErrors(false);
        // A new price asks again: the policy accepted is the one on this quote.
        setAccepted(false);
        go({ kind: "review", offer, quote: r.value });
        return;
      }
      if (!outcomeUnknown(r)) quoteKey.current.done();
      apply(quoteTrouble(r, offer, limits), offer);
    });

  /**
   * Read the checkout until it reaches a final state, as the web app does
   * after a payment or a hold's expiry. After a payment was sent, an
   * "expired" can still turn into a booking or a refund for a short while.
   */
  const watch = (
    offer: TripOffer,
    session: CheckoutSession,
    secret: string,
    label = "checking",
  ) => {
    polls.current += 1;
    const step = epoch.current;
    const mine = polls.current;
    const still = () => alive.current && epoch.current === step && polls.current === mine;
    setStalled(false);
    setWaiting(label);
    void (async () => {
      let lateUntil: number | null = null;
      for (let i = 0; ; i++) {
        await new Promise((r) => setTimeout(r, pollDelay(i)));
        if (!still()) return;
        const r = await readCheckout(endpoint, session.id, secret);
        if (!still()) return;
        if (r.kind === "ok" && finalStates.has(r.value.state)) {
          // A payment whose event never arrived can still book or refund once resent: keep the page.
          if (r.value.state === "expired" && mustResend(delivery.current)) {
            // Stop reading and free the pay buttons, so the payment can be sent again.
            setWaiting(null);
            setStalled(true);
            return;
          }
          const late = r.value.state === "expired" && paymentSent.current;
          if (late && lateUntil === null) lateUntil = Date.now() + lateSuccessGraceMs;
          if (!late || (lateUntil !== null && Date.now() > lateUntil)) {
            go({ kind: "outcome", offer, session: r.value, secret });
            return;
          }
        }
        if (r.kind === "refused" && (r.status === 401 || r.status === 404)) {
          // The checkout is gone for this secret: nothing more can be learned here.
          go({ kind: "outcome", offer, session: { ...session, state: "canceled" }, secret });
          return;
        }
        if (i === 15) {
          // About a minute: say so, and keep reading.
          setStalled(true);
        }
      }
    })();
  };

  // Review -> a hold and the payment.
  const hold = (offer: TripOffer, quote: Quote) =>
    exclusive("hold", async (still) => {
      setShowErrors(true);
      setNotice(null);
      const problems = bookerProblems(name, email);
      if (!doubtedFields.current && (problems.name || problems.email || !accepted)) return;
      const fields: CheckoutFields = doubtedFields.current ?? {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: name.trim(), email: email.trim() },
      };
      const { key, secret } = attempt.current.for(JSON.stringify(fields));
      const r = await openCheckout(endpoint, { ...fields, checkoutSecret: secret }, key);
      if (!still()) return;
      if (r.kind !== "ok") {
        const rateLimited = r.kind === "refused" && r.code === "rate_limited";
        if (outcomeUnknown(r) || (doubtedFields.current && rateLimited)) {
          // The checkout may exist: keep its key and secret, and allow only the same request.
          doubtedFields.current = fields;
          setInDoubt(true);
          setNotice({
            kind: "notice",
            title: "We couldn't confirm that your checkout started",
            body: rateLimited
              ? "Wait a minute, then press Try again. It sends the same details."
              : "Press Try again. It sends the same details, so you won't be charged twice.",
          });
          return;
        }
        attempt.current.done();
        doubtedFields.current = null;
        setInDoubt(false);
        apply(checkoutTrouble(r, operator, isCharter(offer)), offer);
        return;
      }
      // A retry after a lost answer may replay an old snapshot, which teaches nothing.
      if (!r.replayed) clock.current.learn(r.value.session.createdAt);
      attempt.current.done();
      doubtedFields.current = null;
      setInDoubt(false);
      paymentSent.current = false;
      setDelivery("none");
      const { session, payment } = r.value;
      if (payment && payment.provider !== "fake" && session.state === "open") {
        // The demo app pays only with the demo's test provider; give the seats back at once.
        void cancelCheckout(endpoint, session.id, secret);
        setNotice({
          kind: "notice",
          title: "Card payment isn't in the demo app yet",
          body: "This operator takes cards online. Book this trip on the website for now.",
        });
        go({ kind: "party", offer });
        return;
      }
      if (!payment || session.state !== "open") {
        // A replay or a late answer: read where the checkout stands now.
        go({ kind: "pay", offer, session, payment: null, secret });
        watch(offer, session, secret);
        return;
      }
      go({ kind: "pay", offer, session, payment, secret });
    });

  const pay = (
    offer: TripOffer,
    session: CheckoutSession,
    payment: CheckoutPayment,
    secret: string,
    outcome: TestPaymentOutcome,
  ) =>
    exclusive(outcome, async (still) => {
      setNotice(null);
      // Before sending: a lost or late answer may still have settled the payment.
      paymentSent.current = true;
      const r = await settleTestPayment(endpoint, payment, outcome);
      if (!still()) return;
      // A lost answer keeps resending open past the hold's end, as a failed delivery does.
      setDelivery(afterSettle(delivery.current, r));
      const definiteRefusal = r.kind === "refused" && !outcomeUnknown(r);
      if (!definiteRefusal && mustResend(delivery.current)) {
        // Settled with its event not recorded, or maybe: only the same settle can tell.
        // Stop any read started when the hold ran out, and free the pay buttons.
        polls.current += 1;
        setWaiting(null);
        setNotice(
          r.kind === "network"
            ? {
                kind: "notice",
                title: "We couldn't reach the booking service",
                body: "Check your connection, then press the same button again. It can't charge twice.",
              }
            : {
                kind: "notice",
                title: "The test payment hasn't reached your booking yet",
                body: "Press the same button again. It can't charge twice.",
              },
        );
        return;
      }
      if (r.kind === "network") {
        setNotice({
          kind: "notice",
          title: "We couldn't reach the booking service",
          body: "Check your connection, then try again.",
        });
        return;
      }
      if (r.kind === "refused") {
        // Settling is idempotent by payment: a refusal may mean it already settled.
        const now = await readCheckout(endpoint, session.id, secret);
        if (!still()) return;
        if (now.kind === "ok" && now.value.state === "expired") {
          // A payment event may still be on its way: wait out the late-success grace.
          watch(offer, session, secret, outcome);
          return;
        }
        if (now.kind === "ok" && finalStates.has(now.value.state)) {
          go({ kind: "outcome", offer, session: now.value, secret });
          return;
        }
        // Not confirmed either way: an earlier try may have settled with its answer lost.
        setNotice({
          kind: "notice",
          title: "We couldn't confirm the test payment",
          body: `${r.status === 429 ? "Wait a minute, then" : "Wait a moment, then"} press the same button again. It can't charge twice.`,
        });
        return;
      }
      watch(offer, session, secret, outcome);
    });

  /** Canceling now would close the checkout with its payment's event still to deliver. */
  const resendFirst = () =>
    setNotice({
      kind: "notice",
      title: "Send the test payment again first",
      body: "It may not have reached your booking yet. Press the same payment button again. It can't charge twice.",
    });

  const cancel = (offer: TripOffer, session: CheckoutSession, secret: string) =>
    exclusive("cancel", async (still) => {
      if (mustResend(delivery.current)) {
        resendFirst();
        return;
      }
      setNotice(null);
      const r = await cancelCheckout(endpoint, session.id, secret);
      if (!still()) return;
      const gone = r.kind === "refused" && (r.status === 401 || r.status === 404);
      if (r.kind === "ok" || gone) {
        setNotice({
          kind: "notice",
          title: "This checkout was canceled",
          body: `${paymentSent.current ? "If your test payment went through, it is refunded in full. " : "Nothing was charged. "}${isCharter(offer) ? "The boat is" : "Your seats are"} released. Change your party, or continue for a new price.`,
        });
        go({ kind: "party", offer });
        return;
      }
      if (r.kind === "refused" && r.status === 409) {
        // Too late to cancel: it was paid or ended. Show what happened.
        const now = await readCheckout(endpoint, session.id, secret);
        if (!still()) return;
        if (now.kind === "ok" && now.value.state === "expired" && paymentSent.current) {
          // A payment event may still be on its way: wait out the late-success grace.
          watch(offer, session, secret);
          return;
        }
        if (now.kind === "ok" && finalStates.has(now.value.state)) {
          go({ kind: "outcome", offer, session: now.value, secret });
          return;
        }
      }
      setNotice({
        kind: "notice",
        title: "We couldn't cancel the checkout",
        body: "Check your connection, then try again. The hold ends on its own when time runs out.",
      });
    });

  // The hold's clock, and reads of the checkout once it runs out.
  const paying = phase.kind === "pay" && phase.payment ? phase : null;
  useEffect(() => {
    if (!paying) return;
    setNow(clock.current.now());
    const tick = setInterval(() => setNow(clock.current.now()), 5_000);
    const wait = Math.max(0, Date.parse(paying.session.expiresAt) - clock.current.now()) + 1_000;
    const expiry = setTimeout(() => {
      setNow(clock.current.now());
      watch(paying.offer, paying.session, paying.secret);
    }, wait);
    return () => {
      clearInterval(tick);
      clearTimeout(expiry);
    };
  }, [paying]);

  const back = useCallback(() => {
    if (lock.current) return;
    if (phase.kind === "review") {
      if (inDoubt) {
        setNotice({
          kind: "notice",
          title: "Your checkout may have started",
          body: "Press Try again first, so no seats stay held for you by mistake.",
        });
        return;
      }
      setNotice(null);
      go({ kind: "party", offer: phase.offer });
      return;
    }
    if (phase.kind === "pay") {
      if (!phase.payment) return;
      if (mustResend(delivery.current)) {
        resendFirst();
        return;
      }
      Alert.alert("Leave checkout?", "Canceling releases your hold at once.", [
        { text: "Stay", style: "cancel" },
        {
          text: "Cancel checkout",
          style: "destructive",
          onPress: () => void cancel(phase.offer, phase.session, phase.secret),
        },
      ]);
      return;
    }
    onClose();
  }, [phase, inDoubt, onClose, go]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [back]);

  const title = trip.product.name;
  const when = tripWhen(trip);

  switch (phase.kind) {
    case "loading":
      return (
        <Screen color={color} title={title} onBack={onClose}>
          <Loading label="Loading the trip" />
        </Screen>
      );
    case "failed":
      return (
        <Screen color={color} title={title} onBack={onClose}>
          <Notice
            tone="danger"
            title="This trip didn't load"
            body="Check your connection, then try again."
            action={{ label: "Try again", onPress: load }}
            color={color}
          />
        </Screen>
      );
    case "stop": {
      const t = stopText(phase.stop, operator);
      return (
        <Screen color={color} title={title} onBack={onClose}>
          <Notice tone="warning" title={t.title} body={t.body} />
          <Button action={{ label: "See other trips", onPress: onClose }} color={color} />
        </Screen>
      );
    }
    case "party": {
      const { offer } = phase;
      const limits = partyLimits(offer, trip);
      const sel = selection ?? initialSelection(offer, limits);
      const size = partySize(offer, sel);
      const set = (next: Selection) => {
        setPartyText(null);
        setSelection(fitAddOns(offer, next));
      };
      return (
        <Screen color={color} title={title} onBack={back}>
          <Body muted>
            {when} · {trip.location.name}
          </Body>
          {notice ? <Notice tone="danger" title={notice.title} body={notice.body} /> : null}
          <Heading>Who's coming</Heading>
          {limits.seatsLeft !== null ? (
            <Body muted>
              {limits.seatsLeft === 1 ? "1 seat" : `${limits.seatsLeft} seats`} left on this trip.
            </Body>
          ) : null}
          {isCharter(offer) ? (
            <Stepper
              label={offer.charter?.name ?? "Guests aboard"}
              {...(offer.charter
                ? { hint: `${formatMoney(offer.charter.amount)} for the boat` }
                : {})}
              value={sel.guests}
              min={1}
              max={limits.max}
              onChange={(n) => set({ ...sel, guests: n })}
            />
          ) : (
            offer.tickets.map((t) => (
              <Stepper
                key={t.code}
                label={t.name}
                hint={eachPrice(t.unitAmount)}
                value={sel.tickets[t.code] ?? 0}
                max={Math.max(0, limits.max - size + (sel.tickets[t.code] ?? 0))}
                onChange={(n) => set({ ...sel, tickets: { ...sel.tickets, [t.code]: n } })}
              />
            ))
          )}
          {partyText ? <ErrorText>{partyText}</ErrorText> : null}
          {offer.addOns.length > 0 ? <Heading>Extras</Heading> : null}
          {offer.addOns.map((a) => (
            <Stepper
              key={a.code}
              label={a.name}
              hint={addOnHint(a)}
              value={sel.addOns[a.code] ?? 0}
              max={addOnLimit(a, size)}
              onChange={(n) => set({ ...sel, addOns: { ...sel.addOns, [a.code]: n } })}
            />
          ))}
          <Button
            action={{
              label: "Continue",
              onPress: () => void price(offer, limits),
            }}
            color={color}
            busy={busy === "quote"}
          />
        </Screen>
      );
    }
    case "review": {
      const { offer, quote } = phase;
      const problems = showErrors ? bookerProblems(name, email) : {};
      return (
        <Screen color={color} title={title} onBack={back}>
          <Body muted>
            {when} · {guests(quote.partySize)}
          </Body>
          {notice ? <Notice tone="danger" title={notice.title} body={notice.body} /> : null}
          <Heading>Your price</Heading>
          <View>
            {quoteRows(quote).map((row) => (
              <View key={row.id} style={rowStyle(row.kind)}>
                <View style={styles.fill}>
                  <Text style={rowText(row.kind)}>{row.label}</Text>
                  {row.detail ? <Text style={styles.hint}>{row.detail}</Text> : null}
                </View>
                <Text style={rowText(row.kind)}>{row.amount}</Text>
              </View>
            ))}
          </View>
          <Body muted>
            This price holds until {deadlineText(quote.expiresAt, quote.trip.timeZone)}.
          </Body>
          <Heading>Who's booking</Heading>
          <Body muted>This is a demo: use a made-up name and email.</Body>
          <Field
            label="Full name"
            value={name}
            onChangeText={setName}
            autoComplete="name"
            textContentType="name"
            error={problems.name}
          />
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoComplete="email"
            textContentType="emailAddress"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            error={problems.email}
          />
          <Heading>Cancellation policy</Heading>
          {policySummary(quote.policy, quote.trip, clock.current.now()).map((line) => (
            <Body key={line}>{line}</Body>
          ))}
          <Pressable
            onPress={() => setAccepted(!accepted)}
            accessibilityRole="switch"
            accessibilityState={{ checked: accepted }}
            style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}
          >
            <Switch value={accepted} onValueChange={setAccepted} importantForAccessibility="no" />
            <View style={styles.fill}>
              <Text style={styles.body}>I accept this cancellation policy.</Text>
              <Text style={styles.hint}>Policy version {quote.policy.version}.</Text>
            </View>
          </Pressable>
          {showErrors && !accepted ? (
            <ErrorText>Accept the cancellation policy to continue.</ErrorText>
          ) : null}
          <Button
            action={{
              label: inDoubt ? "Try again" : "Continue to payment",
              onPress: () => void hold(offer, quote),
            }}
            color={color}
            busy={busy === "hold"}
          />
        </Screen>
      );
    }
    case "pay": {
      const { offer, session, payment, secret } = phase;
      const left = Date.parse(session.expiresAt) - now;
      const held = isCharter(offer) ? "The boat is" : "Your seats are";
      const working = busy !== null || waiting !== null;
      const checkAgain = {
        label: "Check again",
        onPress: () => watch(offer, session, secret),
      };
      if (!payment) {
        return (
          <Screen color={color} title="Payment" onBack={back}>
            <Body>Checking where your checkout stands.</Body>
            {stalled ? (
              <Notice
                tone="warning"
                title="This is taking longer than usual"
                body="Check your email for a confirmation, or check again."
                action={checkAgain}
                color={color}
              />
            ) : (
              <Loading label="Checking your checkout" />
            )}
          </Screen>
        );
      }
      return (
        <Screen color={color} title="Payment" onBack={back}>
          <Notice
            title="This is a demo test payment"
            body="No real card is charged and no money moves. Choose how the test payment ends: it succeeds, or the card is declined."
          />
          <Body muted>Amount to pay</Body>
          <Text style={{ fontSize: 28, fontWeight: "700", color: ink.text }}>
            {formatMoney(session.amount)} USD
          </Text>
          <Body>
            {left > 0
              ? `${held} held for you until ${deadlineText(session.expiresAt, offer.trip.timeZone)}, ${formatTimeLeft(left)} from now.`
              : "The hold has run out. Checking what happened."}
          </Body>
          {notice ? <Notice tone="danger" title={notice.title} body={notice.body} /> : null}
          {stalled ? (
            <Notice
              tone="warning"
              title="The payment is taking longer than usual"
              body="Check your email for a confirmation, or check again."
              action={checkAgain}
              color={color}
            />
          ) : null}
          <Button
            action={{
              label: "Simulate successful payment",
              onPress: () => void pay(offer, session, payment, secret, "succeed"),
            }}
            color={color}
            busy={busy === "succeed" || waiting === "succeed"}
            disabled={working || (left <= 0 && !resend)}
          />
          <Button
            action={{
              label: "Simulate declined payment",
              onPress: () => void pay(offer, session, payment, secret, "fail"),
            }}
            color={color}
            kind="secondary"
            busy={busy === "fail" || waiting === "fail"}
            disabled={working || (left <= 0 && !resend)}
          />
          <Button
            action={{
              label: "Cancel checkout",
              onPress: () => void cancel(offer, session, secret),
            }}
            color={color}
            kind="secondary"
            busy={busy === "cancel"}
            disabled={working || left <= 0 || resend}
          />
          <Body muted>
            Canceling releases {isCharter(offer) ? "the boat" : "your seats"} at once. You can
            change your party and start again.
          </Body>
        </Screen>
      );
    }
    case "outcome":
      return (
        <Outcome
          endpoint={endpoint}
          operator={operator}
          color={color}
          title={title}
          session={phase.session}
          secret={phase.secret}
          paymentTried={paymentSent.current}
          onAgain={() => {
            setNotice(null);
            go({ kind: "party", offer: phase.offer });
          }}
          onClose={onClose}
          onBooked={onBooked}
        />
      );
  }
}

function Outcome({
  endpoint,
  operator,
  color,
  title,
  session,
  secret,
  paymentTried,
  onAgain,
  onClose,
  onBooked,
}: {
  endpoint: Endpoint;
  operator: string;
  color: string;
  title: string;
  session: CheckoutSession;
  secret: string;
  /** A test payment was sent for this checkout, so "expired" or "canceled" may still change. */
  paymentTried: boolean;
  onAgain: () => void;
  onClose: () => void;
  onBooked: (session: OpenedSession) => Promise<void>;
}) {
  const [opening, setOpening] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const [openFailed, setOpenFailed] = useState(false);
  const text = outcomeText(session, operator, paymentTried);
  const confirmed = session.state === "confirmed";
  const open = async () => {
    setOpening(true);
    setOpenFailed(false);
    const r = await openFromCheckout(endpoint, session.id, secret);
    if (!alive.current) return;
    if (r.kind === "ok") {
      await onBooked(r.value);
      return;
    }
    setOpening(false);
    setOpenFailed(true);
  };
  const retryable =
    session.state === "failed" || session.state === "expired" || session.state === "canceled";
  return (
    <Screen color={color} title={title} onBack={onClose}>
      <Notice tone={confirmed ? "success" : "warning"} title={text.title} body={text.body} />
      {confirmed ? (
        <>
          <Button
            action={{ label: "View your booking", onPress: () => void open() }}
            color={color}
            busy={opening}
          />
          {openFailed ? (
            <Body muted>
              We couldn't open it just now. Try again, or use the link in your confirmation email.
            </Body>
          ) : null}
        </>
      ) : retryable ? (
        <Button action={{ label: "Start over", onPress: onAgain }} color={color} />
      ) : null}
      <Button
        action={{ label: "Back to trips", onPress: onClose }}
        color={color}
        kind="secondary"
      />
    </Screen>
  );
}

function rowStyle(kind: string) {
  return {
    flexDirection: "row" as const,
    gap: 12,
    paddingVertical: 8,
    borderTopWidth: kind === "subtotal" || kind === "total" ? 1 : 0,
    borderTopColor: ink.line,
  };
}

function rowText(kind: string) {
  return {
    fontSize: kind === "total" ? 18 : 16,
    fontWeight: kind === "total" ? ("700" as const) : ("400" as const),
    color: kind === "note" ? ink.muted : ink.text,
  };
}
