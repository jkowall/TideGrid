import { useEffect, useRef, useState } from "react";
import { BackHandler } from "react-native";
import { type OpenedSession, openWithLink } from "./booking-api.ts";
import { linkTokenFrom } from "./booking-model.ts";
import { Body, Button, Field, Notice, Screen } from "./ui.tsx";
import type { Endpoint } from "./variant.ts";

/**
 * Open a booking with the link from the confirmation email. The demo app has
 * no deep links (they stay in Wave 5), so the guest pastes the link. The
 * link's token stays in memory and is sent only in a POST body; a link works
 * once, as on the web.
 */
export function LinkScreen({
  endpoint,
  color,
  onClose,
  onOpened,
}: {
  endpoint: Endpoint;
  color: string;
  onClose: () => void;
  onOpened: (session: OpenedSession) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ title: string; body: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const open = async () => {
    // One exchange at a time, from the button or the keyboard: the link works once.
    if (lock.current) return;
    setProblem(null);
    const token = linkTokenFrom(text);
    if (!token) {
      setFieldError("Paste the whole link from your confirmation email.");
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    lock.current = true;
    const r = await openWithLink(endpoint, token);
    if (!alive.current) return;
    if (r.kind !== "ok") lock.current = false;
    if (r.kind === "ok") {
      setText("");
      await onOpened(r.value);
      return;
    }
    setBusy(false);
    if (r.kind === "refused" && r.status < 500 && r.status !== 429) {
      setProblem({
        title: "This link doesn't open a booking",
        body: "A link works once and expires. Use the newest one in your email, or ask the operator for a new one.",
      });
    } else {
      setProblem({
        title: "We couldn't reach the booking service",
        body: "Check your connection, then try again.",
      });
    }
  };

  return (
    <Screen color={color} title="Open a booking" onBack={onClose}>
      <Body>Paste the link from your confirmation email to see your booking here.</Body>
      <Field
        label="Booking link"
        value={text}
        onChangeText={setText}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="go"
        onSubmitEditing={() => void open()}
        error={fieldError}
      />
      {problem ? <Notice tone="danger" title={problem.title} body={problem.body} /> : null}
      <Button
        action={{ label: "Open booking", onPress: () => void open() }}
        color={color}
        busy={busy}
      />
    </Screen>
  );
}
