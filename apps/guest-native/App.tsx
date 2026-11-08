import { type AvailableTrip, type PublicBrand, primaryInk } from "@tidegrid/contracts";
import Constants from "expo-constants";
import { getRandomValues } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { isoDate, loadStart, loadTrips, type Start, type Trips } from "./src/api.ts";
import { BookingScreen } from "./src/BookingScreen.tsx";
import { BookScreen } from "./src/BookScreen.tsx";
import { tripWhen } from "./src/booking-model.ts";
import { LinkScreen } from "./src/LinkScreen.tsx";
import { setRandomSource } from "./src/random.ts";
import { SessionStore, type StoredSession } from "./src/sessions.ts";
import { type Endpoint, endpointFor, type Variant, variantFor } from "./src/variant.ts";

// The platform's secure generator, for checkout secrets and Idempotency-Keys.
setRandomSource((bytes) => {
  getRandomValues(bytes);
});

/** Booking sessions live in the Keychain or Keystore, readable only while the phone is unlocked. */
const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const secureStore = {
  get: (key: string) => SecureStore.getItemAsync(key, secureOptions),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value, secureOptions),
  remove: (key: string) => SecureStore.deleteItemAsync(key, secureOptions),
};

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
const variant: Variant | null = variantFor(extra.variant);
const endpoint: Endpoint | null = variant
  ? endpointFor(variant, {
      ...(extra.apiBase ? { apiBase: extra.apiBase } : {}),
      ...(extra.guestOrigin ? { origin: extra.guestOrigin } : {}),
    })
  : null;

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [start, setStart] = useState<Start | "loading">("loading");
  const retry = useCallback(() => {
    if (!variant || !endpoint) return;
    setStart("loading");
    loadStart(variant, endpoint)
      .then(setStart)
      .catch(() => setStart({ kind: "failed" }));
  }, []);
  useEffect(retry, []);

  if (!variant || !endpoint) {
    return <Message title="This build is misconfigured" body="It names no valid operator." />;
  }
  if (start === "loading") return <Loading />;
  switch (start.kind) {
    case "ready":
      return <Journeys brand={start.brand} endpoint={endpoint} slug={variant.slug} />;
    case "wrong-tenant":
      return (
        <Message
          title="This app cannot open"
          body="The server answered for a different operator, so nothing is shown."
        />
      );
    case "not-published":
      return <Message title="Not available" body="This operator is not published yet." />;
    case "not-ready":
      return (
        <Message
          title={start.tenant.name}
          body="Booking opens soon. Check back later."
          action={{ label: "Check again", onPress: retry }}
        />
      );
    case "failed":
      return (
        <Message
          title="We could not connect"
          body="Check your connection and try again."
          action={{ label: "Try again", onPress: retry }}
        />
      );
  }
}

type Route =
  | { name: "home" }
  | { name: "book"; trip: AvailableTrip }
  | { name: "booking"; session: StoredSession }
  | { name: "link" };

/** The app's screens: home, booking a trip, one booking, and opening an email link. */
function Journeys({
  brand,
  endpoint,
  slug,
}: {
  brand: PublicBrand;
  endpoint: Endpoint;
  slug: string;
}) {
  const store = useMemo(() => new SessionStore(secureStore, slug), [slug]);
  const [route, setRoute] = useState<Route>({ name: "home" });
  /** The route on screen now, so a late answer never moves a guest who has moved on. */
  const current = useRef(route);
  current.current = route;
  const [sessions, setSessions] = useState<StoredSession[] | null>(null);
  const reload = useCallback(() => {
    store
      .list()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [store]);
  useEffect(reload, []);
  const home = useCallback(() => {
    reload();
    setRoute({ name: "home" });
  }, [reload]);
  const keep = useCallback(
    async (opened: StoredSession) => {
      const session = {
        token: opened.token,
        expiresAt: opened.expiresAt,
        reference: opened.reference,
      };
      const from = current.current;
      await store.add(session);
      reload();
      if (current.current === from) setRoute({ name: "booking", session });
    },
    [store, reload],
  );
  const forget = useCallback(
    (reference: string) => {
      void store.remove(reference).then(reload);
    },
    [store, reload],
  );
  const color = brand.colors.primary;
  switch (route.name) {
    case "book":
      return (
        <BookScreen
          endpoint={endpoint}
          operator={brand.name}
          color={color}
          trip={route.trip}
          onClose={home}
          onBooked={keep}
        />
      );
    case "booking":
      return (
        <BookingScreen
          endpoint={endpoint}
          operator={brand.name}
          color={color}
          session={route.session}
          onClose={home}
          onEnded={forget}
          onLink={() => setRoute({ name: "link" })}
        />
      );
    case "link":
      return <LinkScreen endpoint={endpoint} color={color} onClose={home} onOpened={keep} />;
    case "home":
      return (
        <Home
          brand={brand}
          endpoint={endpoint}
          sessions={sessions}
          onBook={(trip) => setRoute({ name: "book", trip })}
          onOpen={(session) => setRoute({ name: "booking", session })}
          onLink={() => setRoute({ name: "link" })}
        />
      );
  }
}

function Home({
  brand,
  endpoint,
  sessions,
  onBook,
  onOpen,
  onLink,
}: {
  brand: PublicBrand;
  endpoint: Endpoint;
  sessions: StoredSession[] | null;
  onBook: (trip: AvailableTrip) => void;
  onOpen: (session: StoredSession) => void;
  onLink: () => void;
}) {
  const [trips, setTrips] = useState<Trips | "loading">("loading");
  const refresh = useCallback(() => {
    setTrips("loading");
    const today = new Date();
    loadTrips(endpoint, { from: isoDate(today, -1), to: isoDate(today, 27) })
      .then(setTrips)
      .catch(() => setTrips({ kind: "failed" }));
  }, [endpoint]);
  useEffect(refresh, []);

  const { primary, accent } = brand.colors;
  // The brand contract guarantees text contrast on primary with this ink.
  const ink = primaryInk(primary);
  const insets = useSafeAreaInsets();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: primary }]} edges={["top"]}>
      <StatusBar style={ink === "#ffffff" ? "light" : "dark"} />
      <View style={styles.header}>
        <Text style={[styles.brandName, { color: ink }]} accessibilityRole="header">
          {brand.name}
        </Text>
        {brand.tagline ? (
          <Text style={[styles.tagline, { color: ink }]}>{brand.tagline}</Text>
        ) : null}
      </View>
      <View style={styles.sheet}>
        {/* One scrolling list, so large text never squeezes the trips out. */}
        <FlatList
          data={trips !== "loading" && trips.kind === "ok" ? trips.trips : []}
          keyExtractor={(t) => t.tripId}
          renderItem={({ item }) => (
            <TripRow trip={item} accent={accent} onPress={() => onBook(item)} />
          )}
          ListHeaderComponent={
            <View style={styles.listHeader}>
              <YourBookings sessions={sessions} onOpen={onOpen} onLink={onLink} accent={primary} />
              <Text style={styles.sectionTitle} accessibilityRole="header">
                Upcoming trips
              </Text>
            </View>
          }
          ListEmptyComponent={
            trips === "loading" ? (
              <ActivityIndicator style={styles.pad} accessibilityLabel="Loading trips" />
            ) : trips.kind === "failed" ? (
              <Inline
                text="Trips did not load."
                action={{ label: "Try again", onPress: refresh }}
                accent={primary}
              />
            ) : (
              <Inline
                text="No trips are open for booking in the next four weeks."
                action={{ label: "Check again", onPress: refresh }}
                accent={primary}
              />
            )
          }
          contentContainerStyle={[styles.list, { paddingBottom: 16 + insets.bottom }]}
        />
      </View>
    </SafeAreaView>
  );
}

function TripRow({
  trip,
  accent,
  onPress,
}: {
  trip: AvailableTrip;
  accent: string;
  onPress: () => void;
}) {
  const left =
    trip.capacity.kind === "seats"
      ? trip.capacity.remaining === 1
        ? "1 seat left"
        : `${trip.capacity.remaining} seats left`
      : "Whole boat";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint="Book this trip"
      style={({ pressed }) => [
        styles.trip,
        { borderLeftColor: accent, transform: [{ scale: pressed ? 0.98 : 1 }] },
      ]}
    >
      <Text style={styles.tripName}>{trip.product.name}</Text>
      <Text style={styles.tripWhen}>
        {tripWhen(trip)} · {trip.location.name}
      </Text>
      <Text style={styles.tripSummary} numberOfLines={2}>
        {trip.product.summary}
      </Text>
      <Text style={styles.tripWhen}>{left}</Text>
    </Pressable>
  );
}

/**
 * The guest's bookings opened on this phone in the last hour, newest first,
 * and a way to open one from the confirmation email's link.
 */
function YourBookings({
  sessions,
  onOpen,
  onLink,
  accent,
}: {
  sessions: StoredSession[] | null;
  onOpen: (session: StoredSession) => void;
  onLink: () => void;
  accent: string;
}) {
  return (
    <View style={styles.bookings}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Your bookings
      </Text>
      {sessions?.map((s) => (
        <Pressable
          key={s.reference}
          onPress={() => onOpen(s)}
          accessibilityRole="button"
          accessibilityLabel={`Booking ${s.reference}`}
          style={({ pressed }) => [
            styles.bookingRow,
            { transform: [{ scale: pressed ? 0.98 : 1 }] },
          ]}
        >
          <Text style={styles.tripName}>Booking {s.reference}</Text>
          <Text style={[styles.tripWhen, { color: "#0e2b1f" }]}>View ›</Text>
        </Pressable>
      ))}
      <Pressable
        onPress={onLink}
        accessibilityRole="button"
        hitSlop={8}
        style={({ pressed }) => [{ transform: [{ scale: pressed ? 0.97 : 1 }] }]}
      >
        <Text style={[styles.link, { textDecorationColor: accent }]}>
          Open a booking from your email
        </Text>
      </Pressable>
    </View>
  );
}

function Loading() {
  return (
    <SafeAreaView style={[styles.fill, styles.center]}>
      <ActivityIndicator size="large" accessibilityLabel="Loading" />
    </SafeAreaView>
  );
}

interface Action {
  label: string;
  onPress: () => void;
}

function Message({ title, body, action }: { title: string; body: string; action?: Action }) {
  return (
    <SafeAreaView style={[styles.fill, styles.center]}>
      <Text style={styles.messageTitle} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.messageBody}>{body}</Text>
      {action ? <Button action={action} color="#143f2e" /> : null}
    </SafeAreaView>
  );
}

function Inline({ text, action, accent }: { text: string; action?: Action; accent: string }) {
  return (
    <View style={styles.pad}>
      <Text style={styles.messageBody}>{text}</Text>
      {action ? <Button action={action} color={accent} /> : null}
    </View>
  );
}

function Button({ action, color }: { action: Action; color: string }) {
  return (
    <Pressable
      onPress={action.onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: color, transform: [{ scale: pressed ? 0.97 : 1 }] },
      ]}
    >
      <Text style={[styles.buttonText, { color: primaryInk(color) }]}>{action.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "#fff" },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24 },
  brandName: { fontSize: 28, fontWeight: "700" },
  tagline: { fontSize: 16, marginTop: 6 },
  sheet: {
    flex: 1,
    backgroundColor: "#fff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
  },
  sectionTitle: { fontSize: 20, fontWeight: "600", paddingHorizontal: 20, color: "#0e2b1f" },
  bookings: { gap: 8, paddingBottom: 16 },
  listHeader: { marginHorizontal: -16, gap: 4 },
  bookingRow: {
    marginHorizontal: 16,
    padding: 14,
    borderRadius: 10,
    backgroundColor: "#f6f7f6",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  link: {
    paddingHorizontal: 20,
    paddingVertical: 6,
    fontSize: 16,
    color: "#0e2b1f",
    textDecorationLine: "underline",
  },
  list: { padding: 16, gap: 12 },
  trip: {
    backgroundColor: "#f6f7f6",
    borderRadius: 10,
    borderLeftWidth: 4,
    padding: 14,
  },
  tripName: { fontSize: 17, fontWeight: "600", color: "#0e2b1f" },
  tripWhen: { fontSize: 15, color: "#4b5e54", marginTop: 4 },
  tripSummary: { fontSize: 15, color: "#0e2b1f", marginTop: 6 },
  pad: { padding: 20 },
  messageTitle: { fontSize: 22, fontWeight: "700", textAlign: "center", color: "#0e2b1f" },
  messageBody: { fontSize: 16, textAlign: "center", marginTop: 8, color: "#4b5e54" },
  button: { marginTop: 16, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
