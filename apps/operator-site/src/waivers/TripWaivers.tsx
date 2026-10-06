import type { TripWaiversResponse } from "@tidegrid/contracts";
import { Button, Notice, Skeleton, StatusBadge } from "@tidegrid/design-system/components";
import { useEffect, useState } from "react";
import type { ReadFailure } from "../http.ts";
import { loadTripWaivers } from "./api.ts";
import { waiverStatuses } from "./model.ts";
import "./waivers.css";

/**
 * A trip's waivers (G2.15), for its roster: the counts at a glance, then each
 * booking's named participants with their status as an icon and a label.
 * Self-contained: it loads its own data, so the roster page only places it,
 * for roles that see guests (owners and booking staff). It prints with the
 * roster, black on white.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; trip: TripWaiversResponse }
  | { kind: "failed"; reason: ReadFailure };

export function TripWaiversCard({ tenantId, tripId }: { tenantId: string; tripId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    void loadTripWaivers(tenantId, tripId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLoad(
        result.kind === "ok"
          ? { kind: "ready", trip: result.value }
          : { kind: "failed", reason: result.reason },
      );
    });
    return () => controller.abort();
  }, [tenantId, tripId, attempt]);

  return (
    <section className="console-card wv-card wv-trip" aria-labelledby="wv-trip-title">
      <h2 id="wv-trip-title">Waivers</h2>
      {load.kind === "loading" && (
        <div aria-busy="true">
          <p className="tg-visually-hidden" role="status">
            Loading waivers…
          </p>
          <Skeleton width="100%" height="4rem" />
        </div>
      )}
      {load.kind === "failed" && (
        <Notice
          tone="error"
          title="Waivers didn't load"
          actions={
            <Button icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        >
          TideGrid isn't responding right now. Try again in a moment.
        </Notice>
      )}
      {load.kind === "ready" && <TripWaiverList trip={load.trip} />}
    </section>
  );
}

function TripWaiverList({ trip }: { trip: TripWaiversResponse }) {
  const { totals } = trip;
  if (trip.bookings.length === 0) return <p className="wv-muted">No bookings on this trip yet.</p>;
  return (
    <>
      <dl className="wv-totals">
        <div>
          <dt>Signed</dt>
          <dd>
            {totals.signed} of {totals.participants}
          </dd>
        </div>
        <div>
          <dt>Waiting</dt>
          <dd>{totals.waiting}</dd>
        </div>
        <div>
          <dt>Need attention</dt>
          <dd>{totals.attention}</dd>
        </div>
        <div>
          <dt>Not named yet</dt>
          <dd>{totals.unnamed}</dd>
        </div>
      </dl>
      <ul className="wv-list">
        {trip.bookings.map((booking) => (
          <li key={booking.bookingId} className="wv-item">
            <div className="wv-item__head">
              <span className="wv-item__name">Booking {booking.reference}</span>
              {booking.unnamedPlaces > 0 && (
                <span className="wv-muted">{booking.unnamedPlaces} not named</span>
              )}
            </div>
            {booking.participants.length > 0 && (
              <ul className="wv-people">
                {booking.participants.map((p) => {
                  const status = waiverStatuses[p.status];
                  return (
                    <li key={p.participantId}>
                      <span>
                        {p.name}
                        {p.minor && <span className="wv-tag">Minor</span>}
                      </span>
                      <StatusBadge tone={status.tone} icon={status.icon}>
                        {status.label}
                      </StatusBadge>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
