import type { GuestParticipantWaiver, WaiverStatusCode } from "@tidegrid/contracts";
import {
  Button,
  type IconName,
  Notice,
  Skeleton,
  StatusBadge,
  type StatusTone,
} from "@tidegrid/design-system/components";
import { useEffect, useRef, useState } from "react";
import { type PartyWaiverList, readPartyWaivers, resendPartyWaiver } from "./api.ts";
import "./waiver.css";

/**
 * The party's waivers on the booking's management page (G2.15). Lane 1's page
 * places it; it reads its own data with the page's booking session, so the
 * page passes only the session and what to show. Each named person's waiver
 * is an icon and a label, never color alone, with where the email went and
 * what the booker can do about it. It reads again when `refresh` changes (the
 * page passes its booking, which changes after each party edit) and when the
 * tab comes back into view, so a signature made in another tab shows. It
 * renders nothing when no waiver applies or the booking is canceled.
 *
 * When a person's email went out and they haven't signed, the booker can send
 * it again (W3-G2.15-rest): to the same address only, within the limits the
 * API holds. To send it somewhere else, the booker changes the address in
 * Who's coming.
 */

const statuses: Record<WaiverStatusCode, { tone: StatusTone; icon: IconName; label: string }> = {
  signed: { tone: "ready", icon: "check-circle", label: "Signed" },
  waiting: { tone: "pending", icon: "clock", label: "Waiting for signature" },
  email_failed: { tone: "blocked", icon: "x-octagon", label: "Email didn't go through" },
  no_address: { tone: "warning", icon: "alert-triangle", label: "Needs an email address" },
  email_held: { tone: "warning", icon: "alert-triangle", label: "Email on hold" },
  not_assigned: { tone: "warning", icon: "alert-triangle", label: "Not sent yet" },
  not_required: { tone: "neutral", icon: "dot", label: "No waiver needed" },
  not_needed: { tone: "neutral", icon: "dot", label: "Not needed" },
};

/** Coming back to the tab reads again, at most this often. */
const REFRESH_AFTER_MS = 10_000;

type Load = { kind: "loading" } | { kind: "ready"; list: PartyWaiverList } | { kind: "failed" };

/**
 * One person's send-again, by their place in the party, with what the list
 * said of them then: once a read shows them differently (signed, a new
 * address, a failed email), the note no longer applies and goes.
 */
type Resend =
  | { kind: "busy" }
  | {
      kind: "sent" | "failed";
      text: string;
      status: string;
      sentTo: string | null;
      at: number;
      /** Says the list changed, so it stays when the list reads again. */
      keep?: boolean;
    };

/** After this long, a sent note gives way to the button again: the 10 minutes have passed. */
const SENT_NOTE_MS = 10 * 60_000;

/** The note still describes this person as the list shows them now. */
function current(resend: Resend | undefined, p: GuestParticipantWaiver): Resend | undefined {
  if (!resend || resend.kind === "busy") return resend;
  if (!resend.keep && (resend.status !== p.status || resend.sentTo !== p.sentTo)) {
    return undefined;
  }
  if (resend.kind === "sent" && Date.now() - resend.at > SENT_NOTE_MS) return undefined;
  return resend;
}

/** Whether the booker can send this person's email again: it went out, and they haven't signed. */
export function canResend(p: GuestParticipantWaiver): boolean {
  if (!p.sentTo) return false;
  return p.status === "email_failed" || (p.status === "waiting" && p.sendsAt === null);
}

/** Why a send-again did not go, in words the booker can act on. */
export function resendProblem(code: string, status: number, operator: string): string {
  switch (code) {
    case "waiver_email_pending":
      return "Their latest email is still on its way. Give it a few minutes, and ask them to check their spam folder.";
    case "waiver_resend_too_soon":
      return "We emailed this address in the last 10 minutes. Try again a little later.";
    case "waiver_resend_held":
      return `We can't email this person again just yet. Try again later, or contact ${operator}.`;
    case "waiver_participant_changed":
      return "Your party changed since the page loaded. Check the list, then try again.";
    case "waiver_resend_limit":
      return `This waiver has been sent as many times as we can for now. Contact ${operator} if it still hasn't arrived.`;
    case "waiver_not_sent":
      return "We can't send this one again from here. Check their email address in Who's coming.";
    case "waiver_not_pending":
    case "waiver_participant_not_found":
      return "This waiver changed since the page loaded. The list now shows where it stands.";
    case "waiver_trip_over":
      return "This trip is over, so its waiver can't be signed now.";
    case "rate_limited":
      return "Too many requests just now. Wait a minute, then try again.";
    default:
      return status >= 500
        ? "The booking site couldn't send it just now. Try again in a few minutes."
        : `Something went wrong. Try again, or contact ${operator}.`;
  }
}

function timeText(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(new Date(iso));
  }
}

function dayText(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(new Date(iso));
  }
}

/** What happened and what the booker can do, in a sentence. */
export function partyWaiverDetail(
  p: GuestParticipantWaiver,
  operator: string,
  timeZone: string,
): string | null {
  const guardian = p.signer === "guardian";
  switch (p.status) {
    case "signed": {
      const by = guardian ? "Signed by a parent or guardian" : "Signed";
      return p.signedAt ? `${by} on ${dayText(p.signedAt, timeZone)}.` : `${by}.`;
    }
    case "waiting":
      if (!p.sentTo) return "Their email is on its way.";
      if (p.sendsAt) {
        return guardian
          ? `We'll email the link to their parent or guardian at ${p.sentTo} at ${timeText(p.sendsAt, timeZone)}.`
          : `We'll email the link to ${p.sentTo} at ${timeText(p.sendsAt, timeZone)}.`;
      }
      return guardian
        ? `We emailed the link to their parent or guardian at ${p.sentTo}.`
        : `We emailed the link to ${p.sentTo}.`;
    case "email_failed":
      return `The email${p.sentTo ? ` to ${p.sentTo}` : ""} didn't go through. Check the address in Who's coming, or contact ${operator}.`;
    case "no_address":
      return guardian
        ? "Add a parent or guardian's email in Who's coming, and we'll send it."
        : "Add their email in Who's coming, and we'll send their waiver.";
    case "email_held":
      return `We can't email this address again just yet. ${operator} can send it once it's allowed.`;
    case "not_assigned":
      return `${operator} hasn't sent this waiver yet. Contact them if your trip is soon.`;
    default:
      return null;
  }
}

export function PartyWaivers({
  session,
  operator,
  timeZone,
  refresh,
  onEnded,
}: {
  /** Lane 1's booking session token; sent only as a bearer header. */
  session: string;
  /** The operator's name, for who to contact. */
  operator: string;
  /** The trip's zone, so a signing day reads on the marina's calendar. */
  timeZone: string;
  /** Any value that changes when the party changes; the page passes its booking. */
  refresh: unknown;
  /** The booking session has ended. */
  onEnded: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [resends, setResends] = useState<Record<number, Resend>>({});
  // Draws again when a sent note runs out, so the button comes back on its own.
  const [, setExpired] = useState(0);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (expiry.current) clearTimeout(expiry.current);
    },
    [],
  );
  const notes = useRef(new Map<number, HTMLParagraphElement>());
  const focusNote = useRef<number | null>(null);
  const loadedAt = useRef(0);
  // Reads and sends are numbered as they start; a list from an earlier one
  // never replaces a list from a later one, whatever order they answer in.
  const started = useRef(0);
  const shown = useRef(0);
  const show = (seq: number, list: PartyWaiverList): boolean => {
    if (seq < shown.current) return false;
    shown.current = seq;
    loadedAt.current = Date.now();
    setLoad({ kind: "ready", list });
    return true;
  };
  const ended = useRef(onEnded);
  useEffect(() => {
    ended.current = onEnded;
  });

  useEffect(() => {
    void refresh;
    void attempt;
    const controller = new AbortController();
    started.current += 1;
    const seq = started.current;
    void readPartyWaivers(session, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        show(seq, result.value);
      } else if (result.kind === "refused" && result.status === 401) {
        ended.current();
      } else {
        // A failed refresh keeps what the page shows; only a first load fails visibly.
        setLoad((current) => (current.kind === "ready" ? current : { kind: "failed" }));
      }
    });
    return () => controller.abort();
  }, [session, refresh, attempt]);

  useEffect(() => {
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - loadedAt.current >= REFRESH_AFTER_MS
      ) {
        setAttempt((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    void resends;
    const position = focusNote.current;
    if (position === null) return;
    focusNote.current = null;
    notes.current.get(position)?.focus();
  }, [resends]);

  async function sendAgain(p: GuestParticipantWaiver) {
    setResends((all) => ({ ...all, [p.position]: { kind: "busy" } }));
    started.current += 1;
    const seq = started.current;
    const result = await resendPartyWaiver(session, p);
    const note = (
      kind: "sent" | "failed",
      text: string,
      now: GuestParticipantWaiver = p,
      keep = false,
    ) =>
      setResends((all) => ({
        ...all,
        [p.position]: { kind, text, status: now.status, sentTo: now.sentTo, at: Date.now(), keep },
      }));
    if (result.kind === "ok") {
      // A later read already shows newer facts: keep them, and read once more
      // so this send shows too.
      if (!show(seq, result.value)) setAttempt((n) => n + 1);
      const now = result.value.participants.find((x) => x.position === p.position) ?? p;
      // The button goes away, so the note takes focus.
      focusNote.current = p.position;
      if (expiry.current) clearTimeout(expiry.current);
      expiry.current = setTimeout(() => setExpired((n) => n + 1), SENT_NOTE_MS + 1000);
      note(
        "sent",
        `Sent again${now.sentTo ? ` to ${now.sentTo}` : ""}. Ask them to check their inbox and spam folder.`,
        now,
      );
      return;
    }
    if (result.kind === "refused" && result.status === 401) {
      setResends((all) => {
        const rest = { ...all };
        delete rest[p.position];
        return rest;
      });
      ended.current();
      return;
    }
    if (result.kind === "refused") {
      const changed =
        result.code === "waiver_not_pending" ||
        result.code === "waiver_participant_not_found" ||
        result.code === "waiver_participant_changed";
      note("failed", resendProblem(result.code, result.status, operator), p, changed);
      // The list reads again, and the note saying so stays.
      if (changed) setAttempt((n) => n + 1);
      return;
    }
    note(
      "failed",
      result.kind === "network"
        ? "We couldn't reach the booking site. Check your connection, then try again."
        : `Something went wrong. Try again, or contact ${operator}.`,
    );
  }

  if (load.kind === "ready" && !load.list.applies) return null;
  const list = load.kind === "ready" ? load.list : null;
  const signed = list?.participants.filter((p) => p.status === "signed").length ?? 0;

  return (
    <section className="manage-card wv-party" aria-labelledby="wv-party-title">
      <div className="manage-card__head">
        <h2 id="wv-party-title" className="booking-section-title">
          Waivers
        </h2>
        {list && list.participants.length > 0 && (
          <p className="manage-quiet">
            {signed} of {list.participants.length} signed
          </p>
        )}
      </div>
      {load.kind === "loading" && (
        <div aria-busy="true">
          <p className="tg-visually-hidden" role="status">
            Loading waivers…
          </p>
          <div className="wv-party__skeleton" aria-hidden="true">
            <Skeleton width="70%" height="1rem" />
            <Skeleton width="100%" height="3rem" />
          </div>
        </div>
      )}
      {load.kind === "failed" && (
        <Notice
          tone="error"
          title="Waivers didn't load"
          actions={
            <Button
              icon="refresh"
              onClick={() => {
                setLoad({ kind: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          }
        >
          We couldn't reach the booking site. Check your connection, then try again.
        </Notice>
      )}
      {list && (
        <>
          <p>
            Everyone in your party signs a waiver for {operator} before the trip. We email each
            person their own link, and a parent or guardian signs for anyone under 18.
          </p>
          {list.participants.length === 0 ? (
            <p className="manage-quiet">
              Name your party in Who's coming, and we'll email each person their waiver.
            </p>
          ) : (
            <ul className="wv-party__list">
              {list.participants.map((p) => {
                const status = statuses[p.status];
                const detail = partyWaiverDetail(p, operator, timeZone);
                const resend = current(resends[p.position], p);
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
                      <StatusBadge tone={status.tone} icon={status.icon}>
                        {status.label}
                      </StatusBadge>
                    </div>
                    {detail && <p className="manage-quiet">{detail}</p>}
                    {resend?.kind !== "sent" && canResend(p) && (
                      <div className="wv-party__actions">
                        <Button
                          icon="mail"
                          busy={resend?.kind === "busy"}
                          busyLabel="Sending…"
                          onClick={() => void sendAgain(p)}
                        >
                          Send again <span className="tg-visually-hidden">to {p.name}</span>
                        </Button>
                      </div>
                    )}
                    <p
                      ref={(el) => {
                        if (el) notes.current.set(p.position, el);
                        else notes.current.delete(p.position);
                      }}
                      tabIndex={-1}
                      role="status"
                      className={
                        resend?.kind === "failed"
                          ? "wv-party__note wv-party__note--problem"
                          : "wv-party__note"
                      }
                    >
                      {resend && resend.kind !== "busy" ? resend.text : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {list.participants.length > 0 && list.unnamedPlaces > 0 && (
            <p className="manage-quiet">
              {list.unnamedPlaces === 1
                ? "1 place isn't named yet. "
                : `${list.unnamedPlaces} places aren't named yet. `}
              Name them in Who's coming, and we'll email their waivers.
            </p>
          )}
        </>
      )}
    </section>
  );
}
