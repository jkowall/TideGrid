import type { MeResponse } from "@tidegrid/contracts";
import { useCallback, useEffect, useState } from "react";
import { ConsoleShell, routeOf } from "./ConsoleShell.tsx";
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
import { forgetSearches } from "./search/model.ts";

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
 * Where to return after signing in (G2.12c). A person who opens a booking,
 * roster, or other page while signed out, or whose session ends on one, signs
 * in and lands back on that page rather than the overview. The address holds
 * dates and ids only (never a name or an email), lives in this browser for
 * half an hour, and is used once. Cloudflare Access returns to the page by
 * itself; this covers the email sign-in link, which opens at /login.
 */
const returnKey = "tidegrid.console.return";
const returnTtlMs = 30 * 60_000;

function returnable(address: string): boolean {
  if (!address.startsWith("/") || address.startsWith("//")) return false;
  const url = new URL(address, window.location.origin);
  if (url.origin !== window.location.origin) return false;
  const route = routeOf(url.pathname);
  return route.kind !== "overview" && route.kind !== "not_found";
}

function rememberReturn(address: string): void {
  if (!returnable(address)) return;
  try {
    window.localStorage.setItem(returnKey, JSON.stringify({ address, at: Date.now() }));
  } catch {
    // Blocked storage: the person lands on the overview, as before.
  }
}

function forgetReturn(): void {
  try {
    window.localStorage.removeItem(returnKey);
  } catch {
    // Nothing stored.
  }
}

/** The page to return to, once: fresh, same-origin, and a console page. */
function takeReturn(): string | null {
  try {
    const raw = window.localStorage.getItem(returnKey);
    window.localStorage.removeItem(returnKey);
    const saved = JSON.parse(raw ?? "null") as { address?: unknown; at?: unknown } | null;
    if (typeof saved?.address !== "string" || typeof saved.at !== "number") return null;
    if (Date.now() - saved.at > returnTtlMs || saved.at > Date.now()) return null;
    return returnable(saved.address) ? saved.address : null;
  } catch {
    return null;
  }
}

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

  // Found signed out on a page (not by signing out): come back to it. Found
  // signed out on the overview, or a page the console lacks, the person signs
  // in from there: a page kept from an earlier visit must not win.
  const foundSignedOut = state.kind === "signed-out" && !state.notice;
  useEffect(() => {
    if (!foundSignedOut) return;
    const here = `${window.location.pathname}${window.location.search}`;
    if (returnable(here)) rememberReturn(here);
    else forgetReturn();
  }, [foundSignedOut]);

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
    const back = takeReturn();
    if (back) window.history.replaceState(null, "", back);
    await refresh(true);
  };

  const signOut = async () => {
    // Signing out on purpose leaves nothing behind for the next person.
    forgetReturn();
    forgetSearches();
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
