import type { PublicBrand, WaiverSigning, WaiverSignProblem } from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  CheckboxField,
  Icon,
  type IconName,
  Notice,
  SelectField,
  Skeleton,
  TextField,
} from "@tidegrid/design-system/components";
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ContactActions } from "../Contact.tsx";
import { useLinkClick } from "../navigation.tsx";
import { useTitle } from "../States.tsx";
import { downloadDocument, openSession, readSession, sign } from "./api.ts";
import { clearStoredSession, loadStoredSession, storeSession, takeLinkToken } from "./session.ts";
import "./waiver.css";

/**
 * The waiver page (G2.15): `/waiver#t=<token>` from the request email. The
 * page never opens the waiver by itself: the token is spent only when the
 * guest taps "Open my waiver", with a POST, so a mail scanner or a link
 * preview that loads the page changes nothing. Then the guest reads the
 * waiver, checks each acknowledgment, confirms who they are, consents to sign
 * electronically, types their name, and signs; and can download the signed
 * PDF. Every refusal has its own designed screen.
 */

type Phase =
  /**
   * `failed`: why the last tap did not open the waiver, when it can be tried
   * again with the same token: no answer, or too many tries for now.
   */
  | { kind: "start"; token: string; opening: boolean; failed: false | "network" | "rate_limited" }
  | { kind: "loading" }
  | { kind: "review"; secret: string; waiver: WaiverSigning }
  | { kind: "signed"; secret: string; waiver: WaiverSigning }
  | { kind: "stopped"; code: string };

interface Stop {
  icon: IconName;
  tone: "neutral" | "warning" | "ready";
  title: string;
  body: (operator: string) => string;
}

const unavailable: Stop = {
  icon: "x-octagon",
  tone: "warning",
  title: "We couldn't reach the booking system",
  body: () => "Check your connection and try again. Nothing was signed.",
};

/** What the page can say about a refusal or a failure, in the guest's terms. */
const stops: Record<string, Stop> = {
  no_link: {
    icon: "mail",
    tone: "neutral",
    title: "Open the link from your email",
    body: (op) =>
      `This page signs a waiver from the link in your email from ${op}. Open that email and tap its button.`,
  },
  waiver_link_invalid: {
    icon: "x-octagon",
    tone: "warning",
    title: "This waiver link doesn't work here",
    body: (op) =>
      `Check that you opened the whole link from your email from ${op}. If it still doesn't work, ask ${op} to send it again.`,
  },
  waiver_link_used: {
    icon: "lock",
    tone: "warning",
    title: "This link was already opened",
    body: (op) =>
      `For your security, each waiver link opens once. If you didn't finish signing, ask ${op} to send you a new link.`,
  },
  waiver_link_expired: {
    icon: "hourglass",
    tone: "warning",
    title: "This link has expired",
    body: (op) => `Waiver links last a few days. Ask ${op} to send you a new one.`,
  },
  waiver_link_replaced: {
    icon: "mail",
    tone: "neutral",
    title: "There's a newer link",
    body: (op) => `${op} sent you a newer email for this waiver. Use the link in the latest one.`,
  },
  waiver_signed: {
    icon: "check-circle",
    tone: "ready",
    title: "This waiver is already signed",
    body: (op) => `${op} has the signed waiver. There's nothing more to do.`,
  },
  waiver_superseded: {
    icon: "refresh",
    tone: "neutral",
    title: "This waiver was updated",
    body: (op) =>
      `${op} updated the waiver. Use the link in the newest email to sign the current version.`,
  },
  waiver_not_needed: {
    icon: "info",
    tone: "neutral",
    title: "This waiver is no longer needed",
    body: () => "The booking changed, so there's nothing to sign here.",
  },
  waiver_session_invalid: {
    icon: "clock",
    tone: "warning",
    title: "Your signing session ended",
    body: (op) =>
      `A signing session lasts an hour after you open the link, and ends when the booking changes. If you still need to sign, ask ${op} to send you a new link.`,
  },
  waiver_changed: {
    icon: "refresh",
    tone: "warning",
    title: "This waiver changed while you were reading",
    body: (op) =>
      `Nothing was signed. Ask ${op} to send you a new link to read the current version.`,
  },
  waiver_participant_changed: {
    icon: "users",
    tone: "warning",
    title: "The booking's details changed",
    body: (op) => `Nothing was signed. ${op} sends a new email when the booking changes who signs.`,
  },
  rate_limited: {
    icon: "clock",
    tone: "warning",
    title: "Too many tries",
    body: () => "Wait a minute, then try again.",
  },
  unavailable,
};

const doneCodes = new Set(["waiver_signed", "waiver_not_needed"]);

function stopFor(code: string): Stop {
  return stops[code] ?? unavailable;
}

/** When it was signed, on this device's clock, with the zone named (the trip's line names its own). */
function signedAtText(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function useHeadingFocus(key: string, enabled: boolean) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (enabled) heading.current?.focus();
  }, [key]);
  return heading;
}

function Panel({
  icon,
  tone,
  title,
  headingRef,
  children,
  actions,
}: {
  icon: IconName;
  tone: "neutral" | "warning" | "ready";
  title: string;
  headingRef: Ref<HTMLHeadingElement>;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="waiver-panel" aria-labelledby="waiver-title">
      <div className={`waiver-panel__icon waiver-panel__icon--${tone}`} aria-hidden="true">
        <Icon name={icon} />
      </div>
      <h1 id="waiver-title" className="waiver-panel__title" ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <div className="waiver-panel__body">{children}</div>
      {actions && <div className="waiver-actions">{actions}</div>}
    </section>
  );
}

function TripFacts({ waiver }: { waiver: WaiverSigning }) {
  const rows: [string, string][] = [
    ["Trip", waiver.trip.name],
    ["Departs", waiver.trip.when],
    ["From", waiver.trip.place],
    ["Booking", waiver.trip.bookingReference],
  ];
  if (waiver.participant) {
    rows.push([
      waiver.signerRole === "guardian" ? "Signing for" : "For",
      waiver.participant.minor ? `${waiver.participant.name} (a minor)` : waiver.participant.name,
    ]);
  }
  return (
    <dl className="waiver-facts">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WaiverText({ waiver }: { waiver: WaiverSigning }) {
  const paragraphs = waiver.waiver.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return (
    <section className="waiver-text" aria-labelledby="waiver-text-title">
      <h2 id="waiver-text-title" className="waiver-section-title">
        Read the waiver
      </h2>
      {paragraphs.map((p, i) => (
        // The text is the operator's, shown as text only; its order never changes.
        <p key={i}>{p}</p>
      ))}
    </section>
  );
}

type Field = WaiverSignProblem["field"];

/** The form's own checks, the same rules the server holds, so most mistakes show at once. */
function localProblems(
  waiver: WaiverSigning,
  form: {
    acks: boolean[];
    identity: boolean;
    consent: boolean;
    signature: string;
    relationship: string;
  },
): WaiverSignProblem[] {
  const problems: WaiverSignProblem[] = [];
  if (!form.acks.every(Boolean)) {
    problems.push({
      field: "acknowledgments",
      code: "required",
      message: "Check every statement to sign",
    });
  }
  if (!form.identity) {
    problems.push({
      field: "confirmIdentity",
      code: "required",
      message:
        waiver.signerRole === "guardian"
          ? `Confirm that you are ${waiver.participant?.name ?? "the minor"}'s parent or legal guardian`
          : `Confirm that you are ${waiver.participant?.name ?? "the participant"}`,
    });
  }
  if (waiver.signerRole === "guardian" && !form.relationship) {
    problems.push({
      field: "relationship",
      code: "required",
      message: "Choose whether you are the parent or the legal guardian",
    });
  }
  if (!form.consent) {
    problems.push({
      field: "consent",
      code: "required",
      message: "Agree to sign electronically to continue",
    });
  }
  if (form.signature.trim().length < 2) {
    problems.push({
      field: "signature",
      code: "required",
      message: "Enter your full name to sign",
    });
  }
  return problems;
}

function ReviewForm({
  waiver,
  secret,
  headingRef,
  onSigned,
  onStopped,
}: {
  waiver: WaiverSigning;
  secret: string;
  headingRef: Ref<HTMLHeadingElement>;
  onSigned: (waiver: WaiverSigning) => void;
  onStopped: (code: string) => void;
}) {
  const [acks, setAcks] = useState(() => waiver.waiver.acknowledgments.map(() => false));
  const [identity, setIdentity] = useState(false);
  const [consent, setConsent] = useState(false);
  const [signature, setSignature] = useState("");
  const [relationship, setRelationship] = useState("");
  const [problems, setProblems] = useState<WaiverSignProblem[]>([]);
  const [signing, setSigning] = useState(false);
  const [offline, setOffline] = useState<false | "network" | "rate_limited">(false);
  const refs = {
    acknowledgments: useRef<HTMLInputElement>(null),
    confirmIdentity: useRef<HTMLInputElement>(null),
    relationship: useRef<HTMLSelectElement>(null),
    consent: useRef<HTMLInputElement>(null),
    signature: useRef<HTMLInputElement>(null),
  };
  const errorFor = (field: Field) => problems.find((p) => p.field === field)?.message;
  const guardian = waiver.signerRole === "guardian";
  const who = waiver.participant?.name ?? "the participant";

  const focusFirst = (found: WaiverSignProblem[]) => {
    const order: Field[] = [
      "acknowledgments",
      "confirmIdentity",
      "relationship",
      "consent",
      "signature",
    ];
    const first = order.find((f) => found.some((p) => p.field === f));
    if (first) refs[first].current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (signing) return;
    const local = localProblems(waiver, { acks, identity, consent, signature, relationship });
    setProblems(local);
    setOffline(false);
    if (local.length > 0) {
      focusFirst(local);
      return;
    }
    setSigning(true);
    const result = await sign(secret, {
      contentSha256: waiver.waiver.contentSha256,
      acknowledgments: acks,
      consent,
      confirmIdentity: identity,
      signature,
      relationship: guardian ? (relationship as "parent" | "legal_guardian") : null,
    });
    setSigning(false);
    switch (result.kind) {
      case "ok":
        onSigned(result.waiver);
        return;
      case "problems":
        setProblems(result.problems);
        focusFirst(result.problems);
        return;
      case "network":
      case "unreadable":
        setOffline("network");
        return;
      case "refused":
        // Too many tries, or the server failed: nothing was signed, and the
        // form stays as it is for another try.
        if (result.status === 429 || result.status >= 500) {
          setOffline(result.status === 429 ? "rate_limited" : "network");
          return;
        }
        onStopped(result.status === 401 ? "waiver_session_invalid" : result.code);
        return;
    }
  };

  return (
    <div className="waiver">
      <header className="waiver-head">
        <p className="waiver-eyebrow">Waiver from {waiver.operatorName}</p>
        <h1 id="waiver-title" ref={headingRef} tabIndex={-1}>
          {waiver.waiver.title}
        </h1>
        <p className="waiver-head__meta">
          {guardian
            ? `A parent or legal guardian signs this for ${who}.`
            : `${who}, this is your own waiver to sign.`}{" "}
          Version {waiver.waiver.version}.
        </p>
      </header>
      <TripFacts waiver={waiver} />
      <WaiverText waiver={waiver} />
      <form className="waiver-form" noValidate onSubmit={(e) => void submit(e)}>
        <fieldset
          className="waiver-group"
          aria-describedby={errorFor("acknowledgments") ? "waiver-acks-error" : undefined}
        >
          <legend className="waiver-section-title">Before you sign</legend>
          {errorFor("acknowledgments") && (
            <p className="tg-field__error" id="waiver-acks-error">
              <Icon name="x-octagon" />
              <span>{errorFor("acknowledgments")}</span>
            </p>
          )}
          {waiver.waiver.acknowledgments.map((text, i) => (
            <CheckboxField
              key={i}
              {...(i === 0 ? { ref: refs.acknowledgments } : {})}
              label={text}
              checked={acks[i] ?? false}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setAcks((list) => list.map((v, j) => (j === i ? checked : v)));
              }}
            />
          ))}
        </fieldset>
        <fieldset className="waiver-group">
          <legend className="waiver-section-title">Who is signing</legend>
          <CheckboxField
            ref={refs.confirmIdentity}
            label={
              guardian
                ? `I am ${who}'s parent or legal guardian, and I can sign for them.`
                : `I am ${who}.`
            }
            checked={identity}
            error={errorFor("confirmIdentity")}
            onChange={(e) => setIdentity(e.currentTarget.checked)}
          />
          {guardian && (
            <SelectField
              ref={refs.relationship}
              label={`Your relationship to ${who}`}
              options={[
                { value: "", label: "Choose one" },
                { value: "parent", label: "Parent" },
                { value: "legal_guardian", label: "Legal guardian" },
              ]}
              value={relationship}
              error={errorFor("relationship")}
              onChange={(e) => setRelationship(e.currentTarget.value)}
            />
          )}
        </fieldset>
        <fieldset className="waiver-group">
          <legend className="waiver-section-title">Sign</legend>
          <CheckboxField
            ref={refs.consent}
            label={waiver.consent.text}
            checked={consent}
            error={errorFor("consent")}
            onChange={(e) => setConsent(e.currentTarget.checked)}
          />
          <TextField
            ref={refs.signature}
            label="Type your full name to sign"
            {...(waiver.participant?.signerName
              ? { hint: `As it appears on the booking: ${waiver.participant.signerName}` }
              : {})}
            autoComplete="name"
            autoCapitalize="words"
            spellCheck={false}
            maxLength={120}
            value={signature}
            error={errorFor("signature")}
            onChange={(e) => setSignature(e.currentTarget.value)}
          />
        </fieldset>
        {offline === "network" && (
          <Notice tone="error" title="We couldn't reach the booking system">
            Nothing was signed. Check your connection, then sign again.
          </Notice>
        )}
        {offline === "rate_limited" && (
          <Notice tone="warning" title="Too many tries">
            Nothing was signed. Wait a minute, then sign again.
          </Notice>
        )}
        <Button
          type="submit"
          variant="primary"
          block
          busy={signing}
          busyLabel="Signing…"
          icon="check"
        >
          Sign waiver
        </Button>
        <p className="waiver-fine-print">
          Your typed name, the time, and this device's address and browser are recorded with the
          signed waiver. {waiver.operatorName} keeps the signed copy.
        </p>
      </form>
    </div>
  );
}

function SignedView({
  waiver,
  secret,
  brand,
  headingRef,
}: {
  waiver: WaiverSigning;
  secret: string;
  brand: PublicBrand;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const linkClick = useLinkClick();
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const signed = waiver.signed;
  const download = async () => {
    setDownloading(true);
    setDownloadFailed(false);
    const result = await downloadDocument(secret);
    setDownloading(false);
    if (result.kind !== "ok") {
      setDownloadFailed(true);
      return;
    }
    const url = URL.createObjectURL(result.value);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waiver-${waiver.trip.bookingReference}.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return (
    <Panel
      icon="check-circle"
      tone="ready"
      title="Waiver signed"
      headingRef={headingRef}
      actions={
        <>
          <Button
            variant="primary"
            icon="receipt"
            busy={downloading}
            busyLabel="Preparing…"
            onClick={() => void download()}
          >
            Download your signed copy
          </Button>
          <ButtonLink variant="ghost" icon="arrow-left" href="/" onClick={linkClick}>
            Back to {brand.name}
          </ButtonLink>
        </>
      }
    >
      <p>
        Thank you{signed ? `, ${signed.signerName}` : ""}. {waiver.operatorName} has the signed
        waiver{waiver.participant ? ` for ${waiver.participant.name}` : ""}.
      </p>
      {signed && (
        <dl className="waiver-facts">
          <div>
            <dt>Signed</dt>
            <dd>{signedAtText(signed.signedAt)}</dd>
          </div>
          <div>
            <dt>Waiver</dt>
            <dd>
              {waiver.waiver.title}, version {waiver.waiver.version}
            </dd>
          </div>
          <div>
            <dt>Trip</dt>
            <dd>
              {waiver.trip.name}, {waiver.trip.when}
            </dd>
          </div>
        </dl>
      )}
      {downloadFailed && (
        <Notice tone="error" title="The copy didn't download">
          Try again in a moment. The signed waiver is safe with {waiver.operatorName}.
        </Notice>
      )}
    </Panel>
  );
}

export function WaiverPage({
  brand,
  focusOnArrival = false,
}: {
  brand: PublicBrand;
  focusOnArrival?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(() => {
    const token = takeLinkToken();
    if (token) return { kind: "start", token, opening: false, failed: false };
    return loadStoredSession() ? { kind: "loading" } : { kind: "stopped", code: "no_link" };
  });
  const moved = useRef(false);
  const phaseKey =
    phase.kind === "stopped"
      ? `stopped:${phase.code}`
      : phase.kind === "start"
        ? "start"
        : phase.kind;
  const heading = useHeadingFocus(phaseKey, focusOnArrival || moved.current);
  useTitle(
    phase.kind === "review" || phase.kind === "signed"
      ? `${phase.kind === "signed" ? "Waiver signed" : "Sign your waiver"} · ${brand.name}`
      : `Waiver · ${brand.name}`,
  );

  const go = useCallback((next: Phase) => {
    moved.current = true;
    setPhase(next);
  }, []);

  const stop = useCallback(
    (code: string) => {
      if (code === "waiver_session_invalid" || doneCodes.has(code)) clearStoredSession();
      go({ kind: "stopped", code });
    },
    [go],
  );

  const show = useCallback(
    (secret: string, waiver: WaiverSigning) => {
      if (waiver.state === "signed" && waiver.signed) {
        go({ kind: "signed", secret, waiver });
      } else if (waiver.state === "pending") {
        go({ kind: "review", secret, waiver });
      } else {
        clearStoredSession();
        go({
          kind: "stopped",
          code: waiver.state === "superseded" ? "waiver_superseded" : "waiver_not_needed",
        });
      }
    },
    [go],
  );

  // A reload in the middle of reading: pick the session up again.
  useEffect(() => {
    if (phase.kind !== "loading") return;
    const stored = loadStoredSession();
    if (!stored) {
      stop("waiver_session_invalid");
      return;
    }
    let live = true;
    void readSession(stored.secret).then((result) => {
      if (!live) return;
      if (result.kind === "ok") show(stored.secret, result.value);
      else if (result.kind === "refused")
        stop(result.status === 401 ? "waiver_session_invalid" : result.code);
      else stop("unavailable");
    });
    return () => {
      live = false;
    };
  }, [phase.kind, show, stop]);

  const open = async (token: string) => {
    setPhase({ kind: "start", token, opening: true, failed: false });
    const result = await openSession(token);
    if (result.kind === "ok") {
      storeSession({
        secret: result.value.secret,
        expiresAt: result.value.waiver.sessionExpiresAt,
      });
      show(result.value.secret, result.value.waiver);
    } else if (result.kind === "refused" && (result.status === 429 || result.status >= 500)) {
      // Too many tries, or the server failed: the link was not spent. Keep
      // the token for another tap.
      setPhase({
        kind: "start",
        token,
        opening: false,
        failed: result.status === 429 ? "rate_limited" : "network",
      });
    } else if (result.kind === "refused") {
      stop(result.code);
    } else {
      // No answer: the link may or may not be spent. Keep the token and let
      // the guest tap again; a spent link then says so.
      setPhase({ kind: "start", token, opening: false, failed: "network" });
    }
  };

  switch (phase.kind) {
    case "start":
      return (
        <div className="guest-container guest-content">
          <Panel
            icon="pencil"
            tone="neutral"
            title="Sign your waiver"
            headingRef={heading}
            actions={
              <Button
                variant="primary"
                icon="chevron-right"
                iconPosition="end"
                busy={phase.opening}
                busyLabel="Opening…"
                onClick={() => void open(phase.token)}
              >
                {phase.failed ? "Try again" : "Open my waiver"}
              </Button>
            }
          >
            <p>{brand.name} needs a signed waiver before the trip. It takes about two minutes.</p>
            <p className="waiver-fine-print">
              The link in your email opens once, so keep this page open until you've signed.
            </p>
            {phase.failed === "network" && (
              <Notice tone="error" title="We couldn't reach the booking system">
                Check your connection, then try again.
              </Notice>
            )}
            {phase.failed === "rate_limited" && (
              <Notice tone="warning" title="Too many tries">
                Wait a minute, then try again. Your link still works.
              </Notice>
            )}
          </Panel>
        </div>
      );
    case "loading":
      return (
        <div className="guest-container guest-content" aria-busy="true">
          <p className="tg-visually-hidden" role="status">
            Loading your waiver…
          </p>
          <div className="waiver-skeleton" aria-hidden="true">
            <Skeleton width="10rem" height="0.875rem" />
            <Skeleton width="min(24rem, 90%)" height="2rem" />
            <Skeleton width="100%" height="6rem" />
            <Skeleton width="100%" height="14rem" />
          </div>
        </div>
      );
    case "review":
      return (
        <div className="guest-container guest-content">
          <ReviewForm
            waiver={phase.waiver}
            secret={phase.secret}
            headingRef={heading}
            onSigned={(waiver) => go({ kind: "signed", secret: phase.secret, waiver })}
            onStopped={stop}
          />
        </div>
      );
    case "signed":
      return (
        <div className="guest-container guest-content">
          <SignedView
            waiver={phase.waiver}
            secret={phase.secret}
            brand={brand}
            headingRef={heading}
          />
        </div>
      );
    case "stopped": {
      const info = stopFor(phase.code);
      const canRetry = phase.code === "unavailable" || phase.code === "rate_limited";
      return (
        <div className="guest-container guest-content">
          <Panel
            icon={info.icon}
            tone={info.tone}
            title={info.title}
            headingRef={heading}
            actions={
              canRetry ? (
                <>
                  <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>
                    Try again
                  </Button>
                  <ContactActions brand={brand} primary={false} />
                </>
              ) : doneCodes.has(phase.code) ? (
                <BackHome brand={brand} />
              ) : (
                <ContactActions brand={brand} />
              )
            }
          >
            <p>{info.body(brand.name)}</p>
          </Panel>
        </div>
      );
    }
  }
}

function BackHome({ brand }: { brand: PublicBrand }) {
  const linkClick = useLinkClick();
  return (
    <ButtonLink variant="primary" icon="arrow-left" href="/" onClick={linkClick}>
      Back to {brand.name}
    </ButtonLink>
  );
}
