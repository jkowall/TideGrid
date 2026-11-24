import { Alert, BackHandler, Platform } from "react-native";

/**
 * Android's back button. A browser has none (the phone app demo page), and
 * React Native for the web warns on every use, so there it does nothing.
 */
export function onHardwareBack(handler: () => boolean): () => void {
  if (Platform.OS === "web") return () => {};
  const sub = BackHandler.addEventListener("hardwareBackPress", handler);
  return () => sub.remove();
}

/**
 * Ask before a step that cannot be taken back. React Native for the web has
 * no Alert, so a browser asks with its own confirm dialog.
 */
export function confirmStep(
  title: string,
  body: string,
  labels: { stay: string; go: string },
  onGo: () => void,
): void {
  if (Platform.OS === "web") {
    if (globalThis.confirm?.(`${title}\n\n${body}`)) onGo();
    return;
  }
  Alert.alert(title, body, [
    { text: labels.stay, style: "cancel" },
    { text: labels.go, style: "destructive", onPress: onGo },
  ]);
}
