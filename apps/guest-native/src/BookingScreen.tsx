import type { ManagedBooking } from "@tidegrid/contracts";
import { formatDuration, formatMoney } from "@tidegrid/design-system/format";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Text, View } from "react-native";
import { endSession, type PartyWaivers, readBooking, readPartyWaivers } from "./booking-api.ts";
import { tripWhen, waiverDetail, waiverStatus } from "./booking-model.ts";
import type { StoredSession } from "./sessions.ts";
import { Body, Button, Heading, ink, Loading, Notice, Screen, styles } from "./ui.tsx";
import type { Endpoint } from "./variant.ts";

/**
 * One booking, as its guest may see it: the trip, where to meet, the party,
 * what was paid, and each named person's waiver. Read with the booking
 * session, as the web app's management page reads it. Changing the party and
 * canceling stay on the web page in this demo.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; booking: ManagedBooking }
  | { kind: "ended" }
  | { kind: "failed" };

const toneColor = {
  ready: "#2e7d4f",
  pending: "#3b6ea8",
  blocked: ink.danger,
  warning: ink.warning,
  neutral: ink.muted,
};

export function BookingScreen({
  endpoint,
  operator,
  color,
  session,
  onClose,
  onEnded,
  onLink,
}: {
  endpoint: Endpoint;
  operator: string;
  color: string;
  session: StoredSession;
  onClose: () => void;
  /** The API says the session ended, or the guest closed it: forget it. */
  onEnded: (reference: string) => void;
  /** Open a booking from the email link instead. */
  onLink: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [waivers, setWaivers] = useState<PartyWaivers | "failed" | null>(null);
  const [closing, setClosing] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const readWaivers = useCallback(() => {
    setWaivers(null);
    void readPartyWaivers(endpoint, session.token).then((r) => {
      if (!alive.current) return;
      setWaivers(r.kind === "ok" ? r.value : "failed");
    });
  }, [endpoint, session]);

  const read = useCallback(() => {
    setLoad({ kind: "loading" });
    void readBooking(endpoint, session.token).then((r) => {
      if (!alive.current) return;
      if (r.kind === "ok") setLoad({ kind: "ready", booking: r.value.booking });
      else if (r.kind === "refused" && r.status === 401) {
        setLoad({ kind: "ended" });
        onEnded(session.reference);
      } else setLoad({ kind: "failed" });
    });
    readWaivers();
  }, [endpoint, session, onEnded, readWaivers]);
  useEffect(read, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const close = async () => {
    setClosing(true);
    await endSession(endpoint, session.token);
    onEnded(session.reference);
    onClose();
  };

  const title = `Booking ${session.reference}`;
  if (load.kind === "loading") {
    return (
      <Screen color={color} title={title} onBack={onClose}>
        <Loading label="Loading your booking" />
      </Screen>
    );
  }
  if (load.kind === "ended") {
    return (
      <Screen color={color} title={title} onBack={onClose}>
        <Notice
          tone="warning"
          title="This booking closed on this phone"
          body="For your security, it stays open for an hour. Open it again with the link in your confirmation email."
        />
        <Button
          action={{ label: "Open a booking from your email", onPress: onLink }}
          color={color}
        />
      </Screen>
    );
  }
  if (load.kind === "failed") {
    return (
      <Screen color={color} title={title} onBack={onClose}>
        <Notice
          tone="danger"
          title="Your booking didn't load"
          body="Check your connection, then try again."
          action={{ label: "Try again", onPress: read }}
          color={color}
        />
      </Screen>
    );
  }

  const b = load.booking;
  const canceled = b.state === "canceled";
  return (
    <Screen color={color} title={title} onBack={onClose}>
      {canceled ? (
        <Notice
          tone="warning"
          title="This booking is canceled"
          body={
            b.refund
              ? `${formatMoney(b.refund.amount)} ${b.refund.state === "succeeded" ? "was" : "is being"} refunded.`
              : "No refund applies."
          }
        />
      ) : (
        <Notice tone="success" title="You're booked" body={`Reference ${b.reference}.`} />
      )}
      <Heading>{b.trip.productName}</Heading>
      <Body>{tripWhen(b.trip)}</Body>
      <Body muted>
        {formatDuration(b.trip.durationMinutes, "long")} on {b.trip.boatName}
      </Body>

      <Heading>Where to meet</Heading>
      <Body>
        {b.location.name}: {b.location.meetingPoint}
      </Body>
      {b.location.meetingInstructions ? <Body muted>{b.location.meetingInstructions}</Body> : null}

      <Heading>Who's coming</Heading>
      <Body>
        {b.party.kind === "charter"
          ? `${b.party.charter}, ${b.party.guests} aboard`
          : b.party.tickets.map((t) => `${t.quantity} ${t.name}`).join(", ")}
      </Body>
      {b.extras.length > 0 ? (
        <Body muted>{b.extras.map((e) => `${e.name} × ${e.quantity}`).join(", ")}</Body>
      ) : null}

      <Heading>Paid</Heading>
      <Body>
        {formatMoney(b.order.totals.total)}{" "}
        {b.payment.provider === "fake" ? "(demo test payment)" : ""}
      </Body>

      <Waivers
        waivers={waivers}
        operator={operator}
        timeZone={b.trip.timeZone}
        color={color}
        onRetry={readWaivers}
      />

      <Body muted>To change your party or cancel, use the link in your confirmation email.</Body>
      <Button
        action={{ label: "Close this booking on this phone", onPress: () => void close() }}
        color={color}
        kind="secondary"
        busy={closing}
      />
    </Screen>
  );
}

function Waivers({
  waivers,
  operator,
  timeZone,
  color,
  onRetry,
}: {
  waivers: PartyWaivers | "failed" | null;
  operator: string;
  timeZone: string;
  color: string;
  onRetry: () => void;
}) {
  if (waivers === null) return <Loading label="Loading waivers" />;
  if (waivers === "failed") {
    return (
      <Notice
        tone="warning"
        title="Waivers didn't load"
        action={{ label: "Try again", onPress: onRetry }}
        color={color}
      />
    );
  }
  if (!waivers.applies) return null;
  return (
    <View style={{ gap: 10 }}>
      <Heading>Waivers</Heading>
      {waivers.participants.map((p) => {
        const s = waiverStatus[p.status];
        const detail = waiverDetail(p, operator, timeZone);
        return (
          <View key={p.position} style={{ gap: 2 }} accessible>
            <Text style={styles.stepLabel}>{p.name}</Text>
            <Text style={{ fontSize: 15, fontWeight: "600", color: toneColor[s.tone] }}>
              {s.symbol} {s.label}
            </Text>
            {detail ? <Text style={styles.hint}>{detail}</Text> : null}
          </View>
        );
      })}
      {waivers.unnamedPlaces > 0 ? (
        <Body muted>
          {waivers.unnamedPlaces === 1
            ? "1 place has no name yet."
            : `${waivers.unnamedPlaces} places have no name yet.`}{" "}
          Name them on the booking's web page so their waivers can be sent.
        </Body>
      ) : null}
    </View>
  );
}
