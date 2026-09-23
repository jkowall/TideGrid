import type { LoginLinkResponse, MeResponse, StaffRole } from "@tidegrid/contracts";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from "react";

/**
 * Sign-in harness for the demo build. It proves the Access and magic-link paths
 * end to end and shows the signed-in identity and tenant roles. The operator
 * console itself arrives in G2.12.
 */

type ErrorBody = { error: { code: string; message: string } };

type State =
  | { kind: "loading" }
  | { kind: "signed-in"; me: MeResponse }
  | { kind: "signed-out"; notice?: string }
  | { kind: "not-provisioned"; message: string }
  | { kind: "failed"; message: string };

const roleLabels: Record<StaffRole, string> = {
  owner: "Owner",
  booking_staff: "Booking staff",
  finance: "Finance (read-only)",
};

const shell: CSSProperties = {
  minHeight: "100dvh",
  background: "var(--tg-harbor)",
  color: "var(--tg-foam)",
  padding: "var(--space-8) var(--space-4)",
};
const panel: CSSProperties = { maxWidth: 640, margin: "0 auto" };
const eyebrow: CSSProperties = {
  fontSize: "var(--text-xs)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--tg-tide-lime)",
};
const muted: CSSProperties = { color: "var(--tg-mist)" };
const button: CSSProperties = {
  minHeight: "var(--tap-min)",
  padding: "0 var(--space-4)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--tg-tide-lime)",
  background: "var(--tg-tide-lime)",
  color: "var(--tg-deep-forest)",
  fontWeight: 600,
  cursor: "pointer",
};
const input: CSSProperties = {
  minHeight: "var(--tap-min)",
  padding: "0 var(--space-3)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--tg-mist)",
  background: "var(--tg-foam)",
  color: "var(--tg-deep-forest)",
  width: "100%",
};

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const refresh = useCallback(async () => {
    const res = await fetch("/api/v1/me", { credentials: "same-origin" });
    if (res.ok) return setState({ kind: "signed-in", me: await readJson<MeResponse>(res) });
    if (res.status === 401) return setState({ kind: "signed-out" });
    if (res.status === 403) {
      const body = await readJson<ErrorBody>(res);
      return setState({ kind: "not-provisioned", message: body.error.message });
    }
    setState({ kind: "failed", message: `The API answered ${res.status}. Try again shortly.` });
  }, []);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    void (async () => {
      if (token) {
        // Drop the token from the address bar and history before using it.
        window.history.replaceState(null, "", "/");
        const res = await fetch("/api/v1/auth/sessions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          return setState({
            kind: "signed-out",
            notice: "That sign-in link is invalid, already used, or expired.",
          });
        }
      }
      await refresh();
    })().catch(() => setState({ kind: "failed", message: "The API could not be reached." }));
  }, [refresh]);

  return (
    <main style={shell}>
      <div style={panel}>
        <p style={eyebrow}>Demo build, synthetic data</p>
        <h1>Operator console</h1>
        <div aria-live="polite">
          {state.kind === "loading" && <p style={muted}>Checking your sign-in…</p>}
          {state.kind === "signed-in" && <SignedIn me={state.me} onSignedOut={refresh} />}
          {state.kind === "signed-out" && <SignIn notice={state.notice} />}
          {state.kind === "not-provisioned" && (
            <>
              <p>{state.message}.</p>
              <p style={muted}>Ask an owner of your operator to add you as a staff member.</p>
            </>
          )}
          {state.kind === "failed" && <p role="alert">{state.message}</p>}
        </div>
      </div>
    </main>
  );
}

function SignedIn({ me, onSignedOut }: { me: MeResponse; onSignedOut: () => Promise<void> }) {
  const { principal, memberships } = me;
  const signOut = async () => {
    await fetch("/api/v1/auth/sessions/current", { method: "DELETE", credentials: "same-origin" });
    await onSignedOut();
  };
  return (
    <section aria-labelledby="who">
      <h2 id="who">Signed in as {principal.displayName}</h2>
      <p style={muted}>
        {principal.email}, through{" "}
        {principal.authMethod === "access" ? "Cloudflare Access" : "an email sign-in link"}.
      </p>
      <h3>Your operators</h3>
      {memberships.length === 0 ? (
        <p style={muted}>You are not a member of any active operator.</p>
      ) : (
        <ul>
          {memberships.map((m) => (
            <li key={m.tenantId}>
              <strong>{m.tenantName}</strong> <span style={muted}>({m.tenantSlug})</span>:{" "}
              {roleLabels[m.role]}
            </li>
          ))}
        </ul>
      )}
      {principal.authMethod === "magic_link" ? (
        <button type="button" style={button} onClick={() => void signOut()}>
          Sign out
        </button>
      ) : (
        <a href="/cdn-cgi/access/logout" style={{ color: "var(--tg-tide-lime)" }}>
          Sign out of Cloudflare Access
        </a>
      )}
    </section>
  );
}

function SignIn({ notice }: { notice?: string | undefined }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [devLink, setDevLink] = useState<string | undefined>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("sending");
    const res = await fetch("/api/v1/auth/login-links", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    if (!res?.ok) return setStatus("failed");
    const body = await readJson<LoginLinkResponse>(res);
    setDevLink(body.devLink);
    setStatus("sent");
  };

  return (
    <section aria-labelledby="signin">
      <h2 id="signin">Sign in</h2>
      {notice && <p role="alert">{notice}</p>}
      <form onSubmit={(e) => void submit(e)} style={{ display: "grid", gap: "var(--space-3)" }}>
        <label htmlFor="email">Work email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={input}
        />
        <div>
          <button type="submit" style={button} disabled={status === "sending"}>
            {status === "sending" ? "Sending…" : "Email me a sign-in link"}
          </button>
        </div>
      </form>
      {status === "sent" && (
        <p style={muted}>If that address has console access, a sign-in link is on its way.</p>
      )}
      {status === "failed" && <p role="alert">The link could not be requested. Try again.</p>}
      {devLink && (
        <p>
          <a href={devLink} style={{ color: "var(--tg-tide-lime)" }}>
            Open the local sign-in link
          </a>{" "}
          <span style={muted}>(local development only)</span>
        </p>
      )}
    </section>
  );
}
