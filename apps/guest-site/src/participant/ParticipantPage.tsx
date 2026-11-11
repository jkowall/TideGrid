import type { ParticipantProfile, PublicBrand } from "@tidegrid/contracts";
import {
  Button,
  ButtonLink,
  Icon,
  type IconName,
  Notice,
  Skeleton,
  TextField,
} from "@tidegrid/design-system/components";
import { zoneCity } from "@tidegrid/design-system/format";
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
import { type FormErrors, formErrors, formOf, type ParticipantForm } from "../manage/model.ts";
import { useLinkClick } from "../navigation.tsx";
import { useTitle } from "../States.tsx";
import { endSession, openWithLink, readProfile, saveOwnDetails } from "./api.ts";
import { clearSession, loadSession, storeSession, takeLinkToken } from "./session.ts";
import "../waiver/waiver.css";

/**
 * The participant page (W3-G2.11-rest): `/participant#t=<token>` from an
 * invitation the booker or the operator sent. The page never opens the
 * details by itself: the token is spent only when the person taps "Open my
 * details", with a POST, so a mail scanner or a link preview that loads the
 * page changes nothing. The session shows this one person's details and the
 * trip, never the rest of the party, the booker's contact details, or the
 * payment, and corrects only those details. Whether someone is a minor is the
 * booker's to set, so it is shown, not edited.
 */

type Phase =
  | { kind: "start"; token: string; opening: boolean; failed: false | "network" | "rate_limited" }
  | { kind: "loading" }
  | { kind: "details"; session: string; profile: ParticipantProfile }
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
  body: () => "Check your connection and try again. Nothing was changed.",
};

const askBooker = "Ask the person who booked to send you a new invitation.";

/** What the page can say about a refusal or a failure, in the person's terms. */
const stops: Record<string, Stop> = {
  no_link: {
    icon: "mail",
    tone: "neutral",
    title: "Open the link from your email",
    body: (op) =>
      `This page opens from the invitation email about a trip with ${op}. Open that email and tap its button.`,
  },
  link_not_found: {
    icon: "x-octagon",
    tone: "warning",
    title: "This link doesn't work here",
    body: () => `Check that you opened the whole link from the email. ${askBooker}`,
  },
  link_used: {
    icon: "lock",
    tone: "warning",
    title: "This link was already opened",
    body: () => `For your security, each invitation opens once. ${askBooker}`,
  },
  link_expired: {
    icon: "hourglass",
    tone: "warning",
    title: "This link has expired",
    body: () => `Invitations last a few days, and end when the trip leaves. ${askBooker}`,
  },
  link_superseded: {
    icon: "mail",
    tone: "neutral",
    title: "There's a newer link",
    body: () => "Open the newest invitation email and use the link in it.",
  },
  link_revoked: {
    icon: "lock",
    tone: "warning",
    title: "This link no longer works",
    body: () => `The booking changed since this email was sent. ${askBooker}`,
  },
  invitation_closed: {
    icon: "clock",
    tone: "neutral",
    title: "This booking no longer takes changes",
    body: (op) =>
      `The trip has left or the booking was canceled, so there's nothing to update. Questions? Contact ${op}.`,
  },
  session_expired: {
    icon: "clock",
    tone: "warning",
    title: "Your session ended",
    body: () =>
      `A session lasts an hour after you open the link, and ends if the booking changes. ${askBooker}`,
  },
  participant_not_found: {
    icon: "users",
    tone: "neutral",
    title: "You're no longer in this booking",
    body: (op) =>
      `The booking's party changed, so there's nothing to update here. Questions? Contact ${op}.`,
  },
  finished: {
    icon: "check-circle",
    tone: "ready",
    title: "All done",
    body: (op) => `${op} has your details. You can close this page.`,
  },
  rate_limited: {
    icon: "clock",
    tone: "warning",
    title: "Too many tries",
    body: () => "Wait a minute, then try again.",
  },
  unavailable,
};

const doneCodes = new Set(["finished", "invitation_closed", "participant_not_found"]);

/** When the trip leaves, on the trip's own clock, with the place it's in. */
export function departsText(startsAt: string, timeZone: string): string {
  const when = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(startsAt));
  return `${when} (${zoneCity(timeZone)} time)`;
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
    <section className="waiver-panel" aria-labelledby="participant-title">
      <div className={`waiver-panel__icon waiver-panel__icon--${tone}`} aria-hidden="true">
        <Icon name={icon} />
      </div>
      <h1 id="participant-title" className="waiver-panel__title" ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <div className="waiver-panel__body">{children}</div>
      {actions && <div className="waiver-actions">{actions}</div>}
    </section>
  );
}

function TripFacts({ profile }: { profile: ParticipantProfile }) {
  const { trip, location } = profile;
  const rows: [string, string][] = [
    ["Trip", trip.productName],
    ["Departs", departsText(trip.startsAt, trip.timeZone)],
    ["From", location.meetingPoint ? `${location.name}, ${location.meetingPoint}` : location.name],
  ];
  if (location.meetingInstructions) rows.push(["Meeting", location.meetingInstructions]);
  rows.push(["Booked by", profile.bookedBy]);
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

type SaveTrouble = { tone: "error" | "warning"; title: string; body: string };

function DetailsForm({
  profile,
  session,
  operator,
  onSaved,
  onStopped,
  onReload,
}: {
  profile: ParticipantProfile;
  session: string;
  operator: string;
  onSaved: (profile: ParticipantProfile) => void;
  onStopped: (code: string) => void;
  onReload: () => void;
}) {
  const minor = profile.participant.isMinor;
  const [form, setForm] = useState<ParticipantForm>(() => formOf(profile.participant));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<SaveTrouble | null>(null);
  const [saved, setSaved] = useState<null | "changed" | "unchanged">(null);
  const fields = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    guardianName: useRef<HTMLInputElement>(null),
    guardianEmail: useRef<HTMLInputElement>(null),
  };
  // One key per set of details; a retry after no answer sends the same request.
  const attempt = useRef<{ body: string; key: string } | null>(null);

  const set = <K extends keyof ParticipantForm>(field: K, value: ParticipantForm[K]) => {
    setSaved(null);
    setForm((f) => ({ ...f, [field]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    // Whether someone is a minor stays as the booker gave it.
    const found = formErrors({ ...form, isMinor: minor });
    setErrors(found);
    setSaved(null);
    const first = (["name", "email", "guardianName", "guardianEmail"] as const).find(
      (k) => found[k],
    );
    if (first) {
      fields[first].current?.focus();
      return;
    }
    const input = {
      name: form.name.trim(),
      email: form.email.trim() ? form.email.trim() : null,
      guardian: minor ? { name: form.guardianName.trim(), email: form.guardianEmail.trim() } : null,
    };
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setTrouble(null);
    const result = await saveOwnDetails(session, input, attempt.current.key);
    setBusy(false);
    if (result.kind === "ok") {
      attempt.current = null;
      setSaved(result.value.changed ? "changed" : "unchanged");
      onSaved(result.value.profile);
      return;
    }
    if (result.kind === "refused") {
      attempt.current = null;
      if (result.status === 401) return onStopped("session_expired");
      if (result.status === 404 && result.code === "participant_not_found") {
        return onStopped("participant_not_found");
      }
      if (result.code === "booking_canceled" || result.code === "trip_departed") {
        return onStopped("invitation_closed");
      }
      if (result.code === "guardian_mismatch") {
        // The booker changed whether this person is a minor meanwhile.
        setTrouble({
          tone: "warning",
          title: "The booking changed",
          body: "Check your details below, then save again.",
        });
        onReload();
        return;
      }
      if (result.status === 429) {
        setTrouble({
          tone: "warning",
          title: "Too many tries",
          body: "Nothing was saved. Wait a minute, then save again.",
        });
        return;
      }
      if (result.status === 400) {
        setTrouble({
          tone: "error",
          title: "Not saved",
          body: "Check the details and try again.",
        });
        return;
      }
    }
    setTrouble({
      tone: "error",
      title: "Not saved",
      body:
        result.kind === "network"
          ? "We couldn't reach the booking system. Check your connection and try again."
          : "Something went wrong on our side. Try again in a moment.",
    });
  };

  return (
    <form className="manage-editor" noValidate onSubmit={(e) => void submit(e)}>
      <fieldset className="booking-group">
        <legend className="booking-group__legend">
          {minor ? `${profile.participant.name}'s details` : "Your details"}
        </legend>
        <p className="manage-quiet">
          {minor
            ? `${profile.bookedBy} listed ${profile.participant.name} as under 18, with you as parent or guardian. ${operator} sends the guardian anything that needs signing.`
            : `${operator} uses these only for this trip, such as to send your own waiver.`}
        </p>
        {trouble && (
          <Notice tone={trouble.tone} title={trouble.title}>
            {trouble.body}
          </Notice>
        )}
        <TextField
          ref={fields.name}
          label={minor ? "Their full name" : "Your full name"}
          autoComplete={minor ? "off" : "name"}
          maxLength={120}
          value={form.name}
          error={errors.name}
          onChange={(e) => set("name", e.target.value)}
        />
        {minor && (
          <>
            <TextField
              ref={fields.guardianName}
              label="Parent or guardian's full name"
              autoComplete="name"
              maxLength={120}
              value={form.guardianName}
              error={errors.guardianName}
              onChange={(e) => set("guardianName", e.target.value)}
            />
            <TextField
              ref={fields.guardianEmail}
              label="Parent or guardian's email"
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={254}
              value={form.guardianEmail}
              error={errors.guardianEmail}
              onChange={(e) => set("guardianEmail", e.target.value)}
            />
          </>
        )}
        <TextField
          ref={fields.email}
          label={minor ? "Their own email (optional)" : "Your email (optional)"}
          hint="Only for messages about this trip."
          type="email"
          inputMode="email"
          autoComplete={minor ? "off" : "email"}
          maxLength={254}
          value={form.email}
          error={errors.email}
          onChange={(e) => set("email", e.target.value)}
        />
        <div role="status" aria-live="polite">
          {saved && (
            <Notice tone="success" title="Saved">
              {saved === "changed"
                ? `${operator} has the new details.`
                : `${operator} already had these details.`}
            </Notice>
          )}
        </div>
        <div className="booking-actions">
          <Button type="submit" variant="primary" icon="check" busy={busy} busyLabel="Saving…">
            Save details
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function ReadOnlyDetails({ profile }: { profile: ParticipantProfile }) {
  const p = profile.participant;
  const rows: [string, string][] = [["Name", p.name]];
  if (p.guardian) rows.push(["Parent or guardian", `${p.guardian.name}, ${p.guardian.email}`]);
  if (p.email) rows.push(["Email", p.email]);
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

export function ParticipantPage({
  brand,
  focusOnArrival = false,
}: {
  brand: PublicBrand;
  focusOnArrival?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(() => {
    const token = takeLinkToken();
    if (token) return { kind: "start", token, opening: false, failed: false };
    return loadSession() ? { kind: "loading" } : { kind: "stopped", code: "no_link" };
  });
  const moved = useRef(false);
  const phaseKey = phase.kind === "stopped" ? `stopped:${phase.code}` : phase.kind;
  const heading = useHeadingFocus(phaseKey, focusOnArrival || moved.current);
  useTitle(
    phase.kind === "details" ? `Your details · ${brand.name}` : `Your trip details · ${brand.name}`,
  );

  const go = useCallback((next: Phase) => {
    moved.current = true;
    setPhase(next);
  }, []);

  const stop = useCallback(
    (code: string) => {
      if (code === "session_expired" || doneCodes.has(code)) clearSession();
      go({ kind: "stopped", code });
    },
    [go],
  );

  const load = useCallback(
    async (session: string) => {
      const result = await readProfile(session);
      if (result.kind === "ok") go({ kind: "details", session, profile: result.value });
      else if (result.kind === "refused" && result.status === 401) stop("session_expired");
      else if (result.kind === "refused" && result.code === "participant_not_found") {
        stop("participant_not_found");
      } else if (result.kind === "refused" && result.status === 429) stop("rate_limited");
      else stop("unavailable");
    },
    [go, stop],
  );

  // A reload: pick the session up again.
  useEffect(() => {
    if (phase.kind !== "loading") return;
    const stored = loadSession();
    if (!stored) {
      stop("session_expired");
      return;
    }
    void load(stored.token);
  }, [phase.kind, load, stop]);

  const open = async (token: string) => {
    setPhase({ kind: "start", token, opening: true, failed: false });
    const result = await openWithLink(token);
    if (result.kind === "ok") {
      storeSession(result.value);
      await load(result.value.token);
    } else if (result.kind === "refused" && (result.status === 429 || result.status >= 500)) {
      // Too many tries, or the server failed: the link was not spent.
      setPhase({
        kind: "start",
        token,
        opening: false,
        failed: result.status === 429 ? "rate_limited" : "network",
      });
    } else if (result.kind === "refused") {
      stop(stops[result.code] ? result.code : "link_not_found");
    } else {
      // No answer: the link may or may not be spent. Keep the token for
      // another tap; a spent link then says so.
      setPhase({ kind: "start", token, opening: false, failed: "network" });
    }
  };

  const finish = (session: string) => {
    clearSession();
    void endSession(session);
    stop("finished");
  };

  switch (phase.kind) {
    case "start":
      return (
        <div className="guest-container guest-content">
          <Panel
            icon="users"
            tone="neutral"
            title="Check your trip details"
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
                {phase.failed ? "Try again" : "Open my details"}
              </Button>
            }
          >
            <p>
              You're in the party for a trip with {brand.name}. Check that your name and email are
              right, so {brand.name} knows who's coming.
            </p>
            <p className="waiver-fine-print">
              This link opens once, so keep this page open until you've finished.
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
            Loading your details…
          </p>
          <div className="waiver-skeleton" aria-hidden="true">
            <Skeleton width="10rem" height="0.875rem" />
            <Skeleton width="min(24rem, 90%)" height="2rem" />
            <Skeleton width="100%" height="8rem" />
            <Skeleton width="100%" height="14rem" />
          </div>
        </div>
      );
    case "details": {
      const { profile, session } = phase;
      return (
        <div className="guest-container guest-content">
          <div className="waiver">
            <header className="waiver-head">
              <p className="waiver-eyebrow">Trip with {brand.name}</p>
              <h1 id="participant-title" ref={heading} tabIndex={-1}>
                {profile.participant.isMinor
                  ? `${profile.participant.name}'s trip details`
                  : "Your trip details"}
              </h1>
            </header>
            <TripFacts profile={profile} />
            {profile.editable ? (
              <DetailsForm
                profile={profile}
                session={session}
                operator={brand.name}
                onSaved={(next) => setPhase({ kind: "details", session, profile: next })}
                onStopped={stop}
                onReload={() => void load(session)}
              />
            ) : (
              <>
                <Notice tone="info" title="These details can't change now">
                  {profile.bookingState === "canceled"
                    ? "This booking was canceled."
                    : "This trip has left."}
                </Notice>
                <ReadOnlyDetails profile={profile} />
              </>
            )}
            <div className="waiver-actions">
              <Button icon="check" onClick={() => finish(session)}>
                I'm done
              </Button>
            </div>
          </div>
        </div>
      );
    }
    case "stopped": {
      const info = stops[phase.code] ?? unavailable;
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
