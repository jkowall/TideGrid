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
import { type PartyWaiverList, readPartyWaivers } from "./api.ts";
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
 */

const statuses: Record<WaiverStatusCode, { tone: StatusTone; icon: IconName; label: string }> = {
  signed: { tone: "ready", icon: "check-circle", label: "Signed" },
  waiting: { tone: "pending", icon: "clock", label: "Waiting for signature" },
  email_failed: { tone: "blocked", icon: "x-octagon", label: "Email didn't go through" },
  no_address: { tone: "warning", icon: "alert-triangle", label: "Needs an email address" },
  not_assigned: { tone: "warning", icon: "alert-triangle", label: "Not sent yet" },
  not_required: { tone: "neutral", icon: "dot", label: "No waiver needed" },
  not_needed: { tone: "neutral", icon: "dot", label: "Not needed" },
};

/** Coming back to the tab reads again, at most this often. */
const REFRESH_AFTER_MS = 10_000;

type Load = { kind: "loading" } | { kind: "ready"; list: PartyWaiverList } | { kind: "failed" };

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
      return guardian
        ? `We emailed the link to their parent or guardian at ${p.sentTo}.`
        : `We emailed the link to ${p.sentTo}.`;
    case "email_failed":
      return `The email${p.sentTo ? ` to ${p.sentTo}` : ""} didn't go through. Check the address in Who's coming, or contact ${operator}.`;
    case "no_address":
      return guardian
        ? "Add a parent or guardian's email in Who's coming, and we'll send it."
        : "Add their email in Who's coming, and we'll send their waiver.";
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
  const loadedAt = useRef(0);
  const ended = useRef(onEnded);
  useEffect(() => {
    ended.current = onEnded;
  });

  useEffect(() => {
    void refresh;
    void attempt;
    const controller = new AbortController();
    void readPartyWaivers(session, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      loadedAt.current = Date.now();
      if (result.kind === "ok") {
        setLoad({ kind: "ready", list: result.value });
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
            Everyone in your party signs {operator}'s waiver before the trip. We email each person
            their own link, and a parent or guardian signs for anyone under 18.
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
                return (
                  <li key={p.position} className="wv-party__item">
                    <div className="wv-party__head">
                      <span className="wv-party__name">
                        {p.name}
                        {p.minor && <span className="wv-party__tag">Under 18</span>}
                      </span>
                      <StatusBadge tone={status.tone} icon={status.icon}>
                        {status.label}
                      </StatusBadge>
                    </div>
                    {detail && <p className="manage-quiet">{detail}</p>}
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
