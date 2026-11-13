import type { DockParty, DockPerson, PublicBrand } from "@tidegrid/contracts";
import {
  Button,
  Icon,
  type IconName,
  Notice,
  StatusBadge,
  type StatusTone,
  TextField,
} from "@tidegrid/design-system/components";
import { type FormEvent, type Ref, useEffect, useRef, useState } from "react";
import { useNavigate } from "../navigation.tsx";
import { useTitle } from "../States.tsx";
import type { Result } from "../waiver/api.ts";
import { type Found, lookUp, readParty, startSigning } from "./api.ts";
import { forgetLookup, recallLookup, rememberLookup } from "./memory.ts";
import "../waiver/waiver.css";

/**
 * The dock page (W3-G2.15-rest, owner decision 2026-11-13): `/dock`, which
 * the operator's printed dock QR code opens. A guest types the booking code
 * and the booker's last name; a match lists that booking's party for a trip
 * departing today, first names with an initial, and starts a signing for one
 * person on this phone. The page never says why a lookup missed, and keeps
 * the lookup's secret in memory only.
 */

export const dockPath = "/dock";

type Trouble =
  | "not_found"
  | "limited"
  | "invalid"
  | "network"
  | "ended"
  | "not_pending"
  | "crew_signing"
  | "busy"
  | "failed";

type Phase =
  | { kind: "form"; busy: boolean; trouble: Trouble | null }
  | { kind: "party"; found: Found; starting: number | null; trouble: Trouble | null };

const troubles: Record<Trouble, { tone: "error" | "warning"; title: string; body: string }> = {
  not_found: {
    tone: "warning",
    title: "We couldn't find that booking for today",
    body: "Check the booking code in your confirmation email and the last name of the person who booked, then try again. If it still doesn't work, ask the crew.",
  },
  limited: {
    tone: "warning",
    title: "Too many tries",
    body: "Ask the crew, who can open your waiver for you.",
  },
  invalid: {
    tone: "error",
    title: "Check the booking code",
    body: "A booking code has only letters and digits, like 7K3M9PQR.",
  },
  network: {
    tone: "error",
    title: "We couldn't reach the booking system",
    body: "Check your connection, then try again.",
  },
  ended: {
    tone: "warning",
    title: "Your lookup ended",
    body: "For privacy, a lookup lasts 15 minutes. Enter the booking code and last name again.",
  },
  not_pending: {
    tone: "warning",
    title: "That waiver can't be signed here now",
    body: "The booking may have changed. Ask the crew if something looks wrong.",
  },
  crew_signing: {
    tone: "warning",
    title: "The crew is already helping this person sign",
    body: "Finish signing with the crew, or ask them.",
  },
  busy: {
    tone: "warning",
    title: "Too many requests",
    body: "Wait a minute, then try again.",
  },
  failed: {
    tone: "error",
    title: "Something went wrong",
    body: "Try again. If it keeps happening, ask the crew.",
  },
};

function troubleOf(result: Exclude<Result<unknown>, { kind: "ok" }>): Trouble {
  if (result.kind === "network") return "network";
  if (result.kind === "unreadable") return "failed";
  switch (result.code) {
    case "dock_lookup_not_found":
      return "not_found";
    case "dock_lookup_limited":
      return "limited";
    case "rate_limited":
      return "busy";
    case "dock_code_invalid":
      return "invalid";
    case "dock_lookup_ended":
      return "ended";
    case "dock_not_pending":
      return "not_pending";
    case "dock_crew_signing":
      return "crew_signing";
    default:
      return "failed";
  }
}

const statuses: Record<DockPerson["status"], { tone: StatusTone; icon?: IconName; label: string }> =
  {
    signed: { tone: "ready", label: "Signed" },
    to_sign: { tone: "pending", icon: "pencil", label: "Needs a signature" },
    not_needed: { tone: "neutral", label: "No waiver needed" },
    ask_crew: { tone: "warning", label: "Ask the crew" },
  };

function TroubleNotice({ trouble }: { trouble: Trouble | null }) {
  if (!trouble) return null;
  const t = troubles[trouble];
  return (
    <Notice tone={t.tone} title={t.title}>
      {t.body}
    </Notice>
  );
}

function LookupForm({
  brand,
  busy,
  trouble,
  onFound,
  onTrouble,
  onBusy,
  headingRef,
}: {
  brand: PublicBrand;
  busy: boolean;
  trouble: Trouble | null;
  onFound: (found: Found) => void;
  onTrouble: (trouble: Trouble) => void;
  onBusy: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [code, setCode] = useState("");
  const [lastName, setLastName] = useState("");
  const [errors, setErrors] = useState<{ code?: string; lastName?: string }>({});
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const next: { code?: string; lastName?: string } = {};
    if (!code.trim()) next.code = "Enter the booking code from your confirmation email";
    if (!lastName.trim()) next.lastName = "Enter the last name of the person who booked";
    setErrors(next);
    if (next.code) return codeRef.current?.focus();
    if (next.lastName) return nameRef.current?.focus();
    onBusy();
    const result = await lookUp({ bookingCode: code.trim(), lastName: lastName.trim() });
    if (result.kind === "ok") onFound(result.value);
    else onTrouble(troubleOf(result));
  };

  return (
    <section className="waiver-panel" aria-labelledby="dock-title">
      <div className="waiver-panel__icon" aria-hidden="true">
        <Icon name="anchor" />
      </div>
      <h1 id="dock-title" className="waiver-panel__title" ref={headingRef} tabIndex={-1}>
        Sign your waiver at the dock
      </h1>
      <div className="waiver-panel__body">
        <p>
          Find your booking with {brand.name} for today, then sign on this phone. You need the
          booking code from your confirmation email and the last name of the person who booked.
        </p>
        <form className="waiver-form" noValidate onSubmit={(e) => void submit(e)}>
          <TextField
            ref={codeRef}
            label="Booking code"
            hint="8 letters and digits, like 7K3M9PQR"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={32}
            value={code}
            error={errors.code}
            onChange={(e) => setCode(e.currentTarget.value)}
          />
          <TextField
            ref={nameRef}
            label="Last name of the person who booked"
            autoComplete="family-name"
            maxLength={80}
            value={lastName}
            error={errors.lastName}
            onChange={(e) => setLastName(e.currentTarget.value)}
          />
          <TroubleNotice trouble={trouble} />
          <div className="waiver-actions">
            <Button
              type="submit"
              variant="primary"
              icon="search"
              busy={busy}
              busyLabel="Finding your booking…"
            >
              Find my booking
            </Button>
          </div>
        </form>
        <p className="waiver-fine-print">
          This works on the day of your trip. No booking code, or no phone? The crew can help you
          sign.
        </p>
      </div>
    </section>
  );
}

function PartyList({
  party,
  starting,
  trouble,
  onStart,
  onAgain,
  headingRef,
}: {
  party: DockParty;
  starting: number | null;
  trouble: Trouble | null;
  onStart: (position: number) => void;
  onAgain: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const waiting = party.people.filter((p) => p.status === "to_sign").length;
  return (
    <section className="waiver" aria-labelledby="dock-title">
      <header className="waiver-head">
        <p className="waiver-eyebrow">{party.trip.name}</p>
        <h1 id="dock-title" ref={headingRef} tabIndex={-1}>
          {waiting === 0 ? "Nothing left to sign here" : "Who's signing?"}
        </h1>
        <p className="waiver-head__meta">Departs {party.trip.when}</p>
      </header>
      <TroubleNotice trouble={trouble} />
      <ul className="wv-party__list">
        {party.people.map((p) => {
          const status = statuses[p.status];
          const guardian = p.signer === "guardian";
          return (
            <li key={p.position} className="wv-party__item">
              <div className="wv-party__head">
                <span className="wv-party__name">
                  {p.name}
                  {p.minor && (
                    <>
                      <span className="tg-visually-hidden">, </span>
                      <span className="wv-party__tag">Under 18</span>
                    </>
                  )}
                </span>
                <StatusBadge tone={status.tone} {...(status.icon ? { icon: status.icon } : {})}>
                  {status.label}
                </StatusBadge>
              </div>
              {p.status === "to_sign" && (
                <div className="wv-party__actions">
                  <Button
                    variant="primary"
                    icon="pencil"
                    busy={starting === p.position}
                    busyLabel="Opening…"
                    disabled={starting !== null && starting !== p.position}
                    onClick={() => onStart(p.position)}
                  >
                    {guardian ? "Sign as parent or guardian" : "Sign"}{" "}
                    <span className="tg-visually-hidden">for {p.name}</span>
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="waiver-fine-print">
        Only the person signing, or a minor's parent or guardian, should sign. Someone missing, or
        marked "Ask the crew"? The crew can help.
      </p>
      <div className="waiver-actions">
        <Button variant="ghost" icon="arrow-left" onClick={onAgain}>
          Look up another booking
        </Button>
      </div>
    </section>
  );
}

export function DockPage({
  brand,
  focusOnArrival,
}: {
  brand: PublicBrand;
  focusOnArrival?: boolean;
}) {
  useTitle(`Sign your waiver · ${brand.name}`);
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<Phase>(() => {
    const found = recallLookup();
    return found
      ? { kind: "party", found, starting: null, trouble: null }
      : { kind: "form", busy: false, trouble: null };
  });
  const moved = useRef(false);

  // A late answer counts only while the page is open and its lookup is still the one held.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = (found: Found) => mounted.current && recallLookup()?.secret === found.secret;

  // Read the party again: someone may have just signed, on this phone or another.
  const refresh = async (found: Found, trouble: Trouble | null) => {
    const result = await readParty(found.secret);
    if (!current(found)) return;
    if (result.kind === "ok") {
      const fresh = { ...found, party: result.value };
      rememberLookup(fresh);
      setPhase((was) =>
        was.kind === "party" && was.found.secret === found.secret && was.starting === null
          ? { kind: "party", found: fresh, starting: null, trouble }
          : was,
      );
    } else if (troubleOf(result) === "ended") {
      forgetLookup();
      setPhase({ kind: "form", busy: false, trouble: "ended" });
    }
  };

  // Coming back from a signing, the remembered party is from before it.
  useEffect(() => {
    if (phase.kind === "party") void refresh(phase.found, null);
  }, []);

  // Focus the heading whenever the page changes what it shows, after the first.
  const shownKey = phase.kind;
  useEffect(() => {
    if (moved.current || focusOnArrival) heading.current?.focus();
    moved.current = true;
  }, [shownKey]);

  // The lookup lapses after 15 minutes: back to the form, saying so.
  const endsAt = phase.kind === "party" ? phase.found.endsAt : null;
  useEffect(() => {
    if (endsAt === null) return;
    const timer = setTimeout(
      () => {
        forgetLookup();
        setPhase({ kind: "form", busy: false, trouble: "ended" });
      },
      Math.max(0, endsAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [endsAt]);

  const start = async (found: Found, position: number) => {
    setPhase({ kind: "party", found, starting: position, trouble: null });
    const result = await startSigning(found.secret, position);
    if (!current(found)) return;
    if (result.kind === "ok") {
      navigate(result.value.path);
      return;
    }
    const trouble = troubleOf(result);
    if (trouble === "ended") {
      forgetLookup();
      setPhase({ kind: "form", busy: false, trouble });
    } else {
      setPhase({ kind: "party", found, starting: null, trouble });
      if (trouble === "not_pending") void refresh(found, trouble);
    }
  };

  return (
    <div className="guest-container guest-content">
      {phase.kind === "form" ? (
        <LookupForm
          brand={brand}
          busy={phase.busy}
          trouble={phase.trouble}
          headingRef={heading}
          onBusy={() => setPhase({ kind: "form", busy: true, trouble: null })}
          onTrouble={(trouble) => setPhase({ kind: "form", busy: false, trouble })}
          onFound={(found) => {
            rememberLookup(found);
            setPhase({ kind: "party", found, starting: null, trouble: null });
          }}
        />
      ) : (
        <PartyList
          party={phase.found.party}
          starting={phase.starting}
          trouble={phase.trouble}
          headingRef={heading}
          onStart={(position) => void start(phase.found, position)}
          onAgain={() => {
            forgetLookup();
            setPhase({ kind: "form", busy: false, trouble: null });
          }}
        />
      )}
    </div>
  );
}
