import { primaryInk } from "@tidegrid/contracts";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useEffect } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

/** Shared pieces of the app's screens: the brand header, buttons, notices, and fields. */

export const ink = {
  text: "#0e2b1f",
  muted: "#4b5e54",
  line: "#d7ddd9",
  surface: "#f6f7f6",
  danger: "#9b1c1c",
  /** 5.4:1 on the surface grey, 5.8:1 on white. */
  warning: "#8a5d0b",
};

export interface Action {
  label: string;
  onPress: () => void;
}

/** A screen under the brand's color: a title bar with an optional back action, then a sheet. */
export function Screen({
  color,
  title,
  onBack,
  children,
  scroll = true,
}: {
  color: string;
  title: string;
  onBack?: (() => void) | undefined;
  children: ReactNode;
  scroll?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const onColor = primaryInk(color);
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: color }]} edges={["top"]}>
      <StatusBar style={onColor === "#ffffff" ? "light" : "dark"} />
      <View style={styles.bar}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
            style={({ pressed }) => [styles.back, { transform: [{ scale: pressed ? 0.97 : 1 }] }]}
          >
            <Text style={[styles.backText, { color: onColor }]}>‹ Back</Text>
          </Pressable>
        ) : null}
        <Text style={[styles.barTitle, { color: onColor }]} accessibilityRole="header">
          {title}
        </Text>
      </View>
      <View style={styles.sheet}>
        {scroll ? (
          <ScrollView
            contentContainerStyle={[styles.sheetBody, { paddingBottom: 24 + insets.bottom }]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            automaticallyAdjustKeyboardInsets
          >
            {children}
          </ScrollView>
        ) : (
          children
        )}
      </View>
    </SafeAreaView>
  );
}

export function Button({
  action,
  color,
  kind = "primary",
  disabled = false,
  busy = false,
}: {
  action: Action;
  color: string;
  kind?: "primary" | "secondary";
  disabled?: boolean;
  busy?: boolean;
}) {
  const primary = kind === "primary";
  const text = primary ? primaryInk(color) : ink.text;
  const off = disabled || busy;
  return (
    <Pressable
      onPress={action.onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: off, busy }}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: off ? ink.line : color }
          : { backgroundColor: "#fff", borderColor: ink.line, borderWidth: 1 },
        { transform: [{ scale: pressed ? 0.97 : 1 }] },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? text : ink.text} />
      ) : (
        <Text style={[styles.buttonText, { color: off && primary ? ink.muted : text }]}>
          {action.label}
        </Text>
      )}
    </Pressable>
  );
}

export function Notice({
  title,
  body,
  tone = "info",
  action,
  color,
}: {
  title: string;
  body?: string;
  tone?: "info" | "warning" | "danger" | "success";
  action?: Action | undefined;
  color?: string;
}) {
  const border = {
    info: "#3b6ea8",
    warning: ink.warning,
    danger: ink.danger,
    success: "#2e7d4f",
  }[tone];
  const urgent = tone === "danger" || tone === "warning";
  // iOS has no live regions: say a new problem aloud when it appears.
  useEffect(() => {
    if (urgent) AccessibilityInfo.announceForAccessibility(body ? `${title}. ${body}` : title);
  }, [urgent, title, body]);
  return (
    <View style={[styles.notice, { borderLeftColor: border }]}>
      <View accessible accessibilityLiveRegion={urgent ? "polite" : "none"} style={{ gap: 6 }}>
        <Text style={styles.noticeTitle}>{title}</Text>
        {body ? <Text style={styles.noticeBody}>{body}</Text> : null}
      </View>
      {action && color ? <Button action={action} color={color} kind="secondary" /> : null}
    </View>
  );
}

/** A whole-number count with − and + buttons. */
export function Stepper({
  label,
  hint,
  value,
  min = 0,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.fill}>
        <Text style={styles.stepLabel}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View
        style={styles.stepper}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={hint ? `${label}, ${hint}` : label}
        accessibilityValue={{ text: String(value) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "increment") onChange(Math.min(max, value + 1));
          if (e.nativeEvent.actionName === "decrement") onChange(Math.max(min, value - 1));
        }}
      >
        <StepButton text="−" disabled={value <= min} onPress={() => onChange(value - 1)} />
        <Text style={styles.stepValue}>{value}</Text>
        <StepButton text="+" disabled={value >= max} onPress={() => onChange(value + 1)} />
      </View>
    </View>
  );
}

function StepButton({
  text,
  disabled,
  onPress,
}: {
  text: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      importantForAccessibility="no"
      style={({ pressed }) => [
        styles.stepButton,
        { opacity: disabled ? 0.35 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] },
      ]}
    >
      <Text style={styles.stepButtonText}>{text}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...input
}: { label: string; error?: string | undefined } & TextInputProps) {
  useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(`${label}: ${error}`);
  }, [label, error]);
  return (
    <View style={styles.field}>
      <Text style={styles.stepLabel}>{label}</Text>
      <TextInput
        {...input}
        accessibilityLabel={label}
        style={[styles.input, error ? { borderColor: ink.danger } : null]}
        placeholderTextColor={ink.muted}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.heading} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.body, muted ? { color: ink.muted } : null]}>{children}</Text>;
}

/** An inline problem beside a field or step, said aloud when it appears. */
export function ErrorText({ children }: { children: string }) {
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(children);
  }, [children]);
  return <Text style={styles.error}>{children}</Text>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <ActivityIndicator style={styles.pad} accessibilityLabel={label} />;
}

export const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 18 },
  back: { alignSelf: "flex-start", paddingVertical: 4, marginBottom: 6 },
  backText: { fontSize: 17, fontWeight: "600" },
  barTitle: { fontSize: 24, fontWeight: "700" },
  sheet: {
    flex: 1,
    backgroundColor: "#fff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  sheetBody: { padding: 20, gap: 14 },
  button: {
    marginTop: 4,
    borderRadius: 8,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 16, fontWeight: "600" },
  notice: {
    backgroundColor: ink.surface,
    borderRadius: 10,
    borderLeftWidth: 4,
    padding: 14,
    gap: 6,
  },
  noticeTitle: { fontSize: 16, fontWeight: "600", color: ink.text },
  noticeBody: { fontSize: 15, color: ink.text },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
  stepLabel: { fontSize: 16, fontWeight: "600", color: ink.text },
  hint: { fontSize: 14, color: ink.muted, marginTop: 2 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: ink.line,
    alignItems: "center",
    justifyContent: "center",
  },
  stepButtonText: { fontSize: 22, color: ink.text },
  stepValue: { minWidth: 28, textAlign: "center", fontSize: 18, color: ink.text },
  field: { gap: 6 },
  input: {
    borderWidth: 1,
    borderColor: ink.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: ink.text,
    minHeight: 48,
  },
  error: { color: ink.danger, fontSize: 14 },
  heading: { fontSize: 20, fontWeight: "600", color: ink.text },
  body: { fontSize: 16, color: ink.text, lineHeight: 22 },
  pad: { padding: 20 },
});
