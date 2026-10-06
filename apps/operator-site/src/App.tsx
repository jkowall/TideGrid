import type { MeResponse } from "@tidegrid/contracts";
import { useCallback, useEffect, useState } from "react";
import { ConsoleShell } from "./ConsoleShell.tsx";
import {
  Checking,
  ConfirmLink,
  Failed,
  type FailureReason,
  type GateNotice,
  NotProvisioned,
  SignIn,
  SignOutControl,
} from "./Gate.tsx";

/**
 * Operator console shell. It hosts the G2.2 sign-in flows unchanged: Cloudflare
 * Access on deployed environments and the magic link locally. Both reach the
 * same session and the same `/api/v1/me`, and every call stays same-origin
 * under /api, forwarded to the API's ConsoleGateway. The shell (ConsoleShell)
 * routes the signed-in pages: the overview, the calendar (G2.12a), and the
 * booking views (G2.12b).
 */

type State =
  | { kind: "loading" }
  | { kind: "confirm-link"; token: string }
  /** `focus`: the shell replaced a screen the person acted on, so its heading takes focus. */
  | { kind: "signed-in"; me: MeResponse; focus: boolean; signOutFailed?: boolean }
  | { kind: "signed-out"; notice?: GateNotice }
  | { kind: "not-provisioned"; message: string; me?: MeResponse }
  | { kind: "failed"; reason: FailureReason };

/**
 * Read a sign-in token from the URL fragment once per page load and remove it
 * from the address bar and history right away. Module scope, not an effect, so
 * development double-rendering cannot lose it.
 */
const linkToken = (() => {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (token) window.history.replaceState(null, "", "/");
  return token;
})();

/** Ask the API who is signed in, and map every answer to a screen. Never throws. */
async function checkSignIn(): Promise<State> {
  try {
    const res = await fetch("/api/v1/me", { credentials: "same-origin" });
    if (res.ok) {
      const me = (await res.json()) as MeResponse;
      if (me.memberships.length === 0) {
        return {
          kind: "not-provisioned",
          message: `${me.principal.email} isn't an active member of any operator.`,
          me,
        };
      }
      return { kind: "signed-in", me, focus: false };
    }
    if (res.status === 401) return { kind: "signed-out" };
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: unknown };
      } | null;
      const message = body?.error?.message;
      return {
        kind: "not-provisioned",
        message:
          typeof message === "string" ? `${message}.` : "This account has no operator access.",
      };
    }
    return { kind: "failed", reason: "unavailable" };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  }
}

export function App() {
  // A sign-in link waits for a click: mail scanners that run scripts must not
  // use it up, and a page on another site must not sign this browser in unasked.
  const [state, setState] = useState<State>(
    linkToken ? { kind: "confirm-link", token: linkToken } : { kind: "loading" },
  );

  /** Check the sign-in again. `focus` when the person pressed something to get here. */
  const refresh = useCallback(async (focus: boolean) => {
    const next = await checkSignIn();
    setState(next.kind === "signed-in" ? { ...next, focus } : next);
  }, []);

  useEffect(() => {
    if (linkToken) return;
    void refresh(false);
  }, [refresh]);

  const redeem = async (token: string) => {
    const res = await fetch("/api/v1/auth/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    if (!res?.ok) {
      return setState({
        kind: "signed-out",
        notice: { tone: "error", title: "That sign-in link is invalid, already used, or expired." },
      });
    }
    await refresh(true);
  };

  const signOut = async () => {
    await fetch("/api/v1/auth/sessions/current", {
      method: "DELETE",
      credentials: "same-origin",
    }).catch(() => null);
    const next = await checkSignIn();
    if (next.kind === "signed-out") {
      return setState({
        kind: "signed-out",
        notice: { tone: "success", title: "You're signed out" },
      });
    }
    // Still signed in: the request did not reach the API. Say so where the
    // person pressed Sign out, and leave the page as it was.
    setState(next.kind === "signed-in" ? { ...next, focus: false, signOutFailed: true } : next);
  };

  switch (state.kind) {
    case "loading":
      return <Checking />;
    case "confirm-link":
      return <ConfirmLink onContinue={() => redeem(state.token)} />;
    case "signed-out":
      return <SignIn notice={state.notice} />;
    case "not-provisioned":
      return (
        <NotProvisioned
          message={state.message}
          signOut={
            <SignOutControl
              method={state.me?.principal.authMethod ?? "access"}
              onSignOut={signOut}
            />
          }
        />
      );
    case "failed":
      return <Failed reason={state.reason} onRetry={() => refresh(true)} />;
    case "signed-in":
      return (
        <ConsoleShell
          me={state.me}
          focusHeading={state.focus}
          signOut={
            <SignOutControl method={state.me.principal.authMethod} onSignOut={signOut} block />
          }
          signOutFailed={state.signOutFailed ?? false}
        />
      );
  }
}
