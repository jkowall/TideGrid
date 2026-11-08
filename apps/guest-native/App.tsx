import { type AvailableTrip, type PublicBrand, primaryInk } from "@tidegrid/contracts";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { isoDate, loadStart, loadTrips, type Start, type Trips } from "./src/api.ts";
import { type Endpoint, endpointFor, type Variant, variantFor } from "./src/variant.ts";

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
      return <Home brand={start.brand} endpoint={endpoint} />;
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
      return <Message title={start.tenant.name} body="Booking opens soon. Check back later." />;
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

function Home({ brand, endpoint }: { brand: PublicBrand; endpoint: Endpoint }) {
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
        <Text style={styles.sectionTitle}>Upcoming trips</Text>
        {trips === "loading" ? (
          <ActivityIndicator style={styles.pad} />
        ) : trips.kind === "failed" ? (
          <Inline
            text="Trips did not load."
            action={{ label: "Try again", onPress: refresh }}
            accent={primary}
          />
        ) : trips.trips.length === 0 ? (
          <Inline text="No trips are open for booking in the next four weeks." accent={primary} />
        ) : (
          <FlatList
            data={trips.trips}
            keyExtractor={(t) => t.tripId}
            renderItem={({ item }) => <TripRow trip={item} accent={accent} />}
            contentContainerStyle={[styles.list, { paddingBottom: 16 + insets.bottom }]}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

function TripRow({ trip, accent }: { trip: AvailableTrip; accent: string }) {
  return (
    <View style={[styles.trip, { borderLeftColor: accent }]} accessible>
      <Text style={styles.tripName}>{trip.product.name}</Text>
      <Text style={styles.tripWhen}>
        {trip.localDate} at {trip.localStartTime.slice(0, 5)} · {trip.location.name}
      </Text>
      <Text style={styles.tripSummary} numberOfLines={2}>
        {trip.product.summary}
      </Text>
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
