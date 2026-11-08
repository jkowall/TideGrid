import type { Invitation, InvitationListResponse, LoginLinkResponse } from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  Icon,
  Notice,
  type NoticeTone,
  Spinner,
  TextField,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

/** The TideGrid wordmark: Sora, with a Tide Lime tide line. */
export function Wordmark() {
  return (
    <span className="console-wordmark">
      <Icon name="wave" className="console-wordmark__mark" />
      TideGrid
    </span>
  );
}

/** Frame for every screen before a signed-in operator: centered, one task. */
export function GateFrame({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · TideGrid console`;
  }, [title]);
  return (
    <main id="console-main" className="console-gate">
      <div className="console-gate__panel">
        <div className="console-gate__brand">
          <Wordmark />
          <span className="console-gate__product">Operator console</span>
        </div>
        {children}
      </div>
      <p className="console-gate__note">Demo build. Synthetic operators and data.</p>
    </main>
  );
}

/**
 * The heading of a gate screen. Each gate screen replaces another screen or
 * the control the person just used, so its heading takes focus when it
 * appears; a screen reader then says where the person is. `describedBy` names
 * a notice the screen opens with, which is read with the heading.
 */
function GateTitle({
  children,
  describedBy,
}: {
  children: ReactNode;
  describedBy?: string | undefined;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <h1 className="console-gate__title" ref={heading} tabIndex={-1} aria-describedby={describedBy}>
      {children}
    </h1>
  );
}

export function Checking() {
  return (
    <GateFrame title="Checking sign-in">
      <p className="console-gate__checking" role="status">
        <Spinner />
        Checking your sign-in…
      </p>
    </GateFrame>
  );
}

export function ConfirmLink({ onContinue }: { onContinue: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <GateFrame title="Finish signing in">
      <GateTitle>Finish signing in</GateTitle>
      <p className="console-gate__lede">This link signs this browser in to the operator console.</p>
      <Button
        variant="primary"
        block
        busy={busy}
        busyLabel="Signing in…"
        onClick={async () => {
          setBusy(true);
          await onContinue();
          setBusy(false);
        }}
      >
        Continue signing in
      </Button>
    </GateFrame>
  );
}

/** A message the sign-in screen opens with, such as a completed sign-out. */
export interface GateNotice {
  tone: Extract<NoticeTone, "success" | "error">;
  title: string;
}

const plausibleEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignIn({ notice }: { notice?: GateNotice | undefined }) {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [sentTo, setSentTo] = useState("");
  const [devLink, setDevLink] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const noticeId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (status === "sending") return;
    const value = email.trim();
    if (!plausibleEmail.test(value)) {
      setFieldError("Enter your work email address, like name@example.com.");
      input.current?.focus();
      return;
    }
    setFieldError(undefined);
    setStatus("sending");
    const res = await fetch("/api/v1/auth/login-links", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: value }),
    }).catch(() => null);
    if (!res?.ok) {
      setStatus("failed");
      return;
    }
    const body = (await res.json()) as LoginLinkResponse;
    setDevLink(body.devLink);
    setSentTo(value);
    setStatus("sent");
  };

  return (
    <GateFrame title="Sign in">
      <GateTitle describedBy={notice ? noticeId : undefined}>Sign in</GateTitle>
      <p className="console-gate__lede">We'll email you a single-use sign-in link. No password.</p>
      {/* The heading takes focus as this screen appears and names the notice as
          its description, so a screen reader reads both, in order, once. A
          live region as well would repeat it. */}
      {notice && <Notice id={noticeId} tone={notice.tone} title={notice.title} announce="none" />}
      <form className="console-gate__form" noValidate onSubmit={(e) => void submit(e)}>
        <TextField
          ref={input}
          id="email"
          label="Work email"
          type="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          value={email}
          error={fieldError}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          block
          busy={status === "sending"}
          busyLabel="Sending…"
        >
          Email me a sign-in link
        </Button>
      </form>
      {status === "sent" && (
        <Notice tone="success" title="Check your email">
          <p>
            If {sentTo} has console access, a sign-in link is on its way. It works once and expires
            shortly.
          </p>
        </Notice>
      )}
      {status === "failed" && (
        <Notice tone="error" title="The link could not be requested">
          <p>Check your connection and try again.</p>
        </Notice>
      )}
      {devLink && (
        <div className="console-gate__dev">
          <ButtonLink variant="secondary" icon="external" href={devLink} block>
            Open the local sign-in link
          </ButtonLink>
          <p className="tg-muted">Local development only. Deployed consoles email the link.</p>
        </div>
      )}
    </GateFrame>
  );
}

/**
 * Sign out, for either sign-in method. Cloudflare Access sessions end at the
 * Access logout page; email-link sessions end with a request, and the button
 * stays busy until it finishes. The visible label is "Sign out" either way.
 */
export function SignOutControl({
  method,
  onSignOut,
  block = false,
}: {
  method: "access" | "magic_link";
  onSignOut: () => Promise<void>;
  block?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (method === "access") {
    return (
      <ButtonLink variant="secondary" icon="log-out" href="/cdn-cgi/access/logout" block={block}>
        Sign out <VisuallyHidden>of Cloudflare Access</VisuallyHidden>
      </ButtonLink>
    );
  }
  return (
    <Button
      variant="secondary"
      icon="log-out"
      block={block}
      busy={busy}
      busyLabel="Signing out…"
      onClick={async () => {
        setBusy(true);
        await onSignOut();
        setBusy(false);
      }}
    >
      Sign out
    </Button>
  );
}

export function NotProvisioned({
  message,
  signOut,
  invitations,
}: {
  message: string;
  signOut: ReactNode;
  /** Shown only to a signed-in person; accepting one takes them into the console. */
  invitations?: ReactNode;
}) {
  return (
    <GateFrame title="No operator access">
      <div className="console-gate__icon">
        <Icon name="lock" />
      </div>
      <GateTitle>No operator access yet</GateTitle>
      <p className="console-gate__lede">{message}</p>
      {invitations}
      <p className="tg-muted">Ask an owner of your operator to add you as a staff member.</p>
      {signOut}
    </GateFrame>
  );
}

const roleNames: Record<Invitation["role"], string> = {
  owner: "owner",
  booking_staff: "booking staff",
  finance: "finance",
};

/**
 * The signed-in person's pending invitations (W3-G2.2b): an owner adding a
 * staff member invites them, and only they accept. Lists nothing when the
 * list cannot load; the screen around it still explains what to do.
 */
export function PendingInvitations({ onAccepted }: { onAccepted: () => Promise<void> }) {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/v1/staff/invitations", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
      .then(async (res) => (res.ok ? ((await res.json()) as InvitationListResponse) : null))
      .catch(() => null)
      .then((body) => {
        if (live) setInvitations(Array.isArray(body?.invitations) ? body.invitations : []);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!invitations || invitations.length === 0) return null;

  async function answer(tenantId: string, accept: boolean) {
    setBusy(tenantId);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/v1/staff/invitations/${encodeURIComponent(tenantId)}/${accept ? "accept" : "decline"}`,
        { method: "POST", credentials: "same-origin", headers: { accept: "application/json" } },
      );
      if (!res.ok) {
        setFailed(true);
        return;
      }
      if (accept) {
        await onAccepted();
        return;
      }
      setInvitations((list) => (list ?? []).filter((i) => i.tenantId !== tenantId));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Invitations" className="console-gate__invitations">
      {failed ? (
        <Notice tone="error" title="That didn't go through">
          Try again.
        </Notice>
      ) : null}
      {invitations.map((i) => (
        <div key={i.tenantId} className="console-gate__invitation">
          <p>
            <strong>{i.tenantName}</strong> invited you to join as {roleNames[i.role] ?? i.role}.
          </p>
          <Button
            variant="primary"
            disabled={busy !== null}
            onClick={() => void answer(i.tenantId, true)}
          >
            Accept
          </Button>
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void answer(i.tenantId, false)}
          >
            Decline
          </Button>
        </div>
      ))}
    </section>
  );
}

/**
 * Why the console could not go on, in words a person can act on: it could not
 * check the sign-in, or a page failed to render (crashed).
 */
export type FailureReason = "unreachable" | "unavailable" | "crashed";

const failureCopy: Record<FailureReason, { title: string; body: string }> = {
  unreachable: {
    title: "The console can't reach TideGrid",
    body: "Check your connection, then try again.",
  },
  unavailable: {
    title: "The console can't reach TideGrid",
    body: "TideGrid isn't responding right now. Try again in a moment.",
  },
  crashed: {
    title: "Something went wrong on this page",
    body: "Try again. If it keeps happening, reload the console.",
  },
};

/**
 * Shown by the error boundary when a page fails to render. "Try again" starts
 * the console afresh on the same page without its query, so an address that
 * caused the failure cannot cause it again.
 */
export function CrashedConsole() {
  return (
    <Failed
      reason="crashed"
      onRetry={async () => window.location.assign(window.location.pathname)}
    />
  );
}

export function Failed({
  reason,
  onRetry,
}: {
  reason: FailureReason;
  onRetry: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <GateFrame title="Console unavailable">
      <div className="console-gate__icon console-gate__icon--warning">
        <Icon name="alert-triangle" />
      </div>
      <GateTitle>{failureCopy[reason].title}</GateTitle>
      <p className="console-gate__lede">{failureCopy[reason].body}</p>
      <Button
        variant="primary"
        icon="refresh"
        block
        busy={busy}
        busyLabel="Trying again…"
        onClick={async () => {
          setBusy(true);
          await onRetry();
          setBusy(false);
        }}
      >
        Try again
      </Button>
    </GateFrame>
  );
}
