import type { AvailableTrip } from "@tidegrid/contracts";
import { Icon } from "@tidegrid/design-system/components";
import {
  formatCutoff,
  formatDate,
  formatDuration,
  formatTripTime,
  zoneCity,
} from "@tidegrid/design-system/format";
import type { Ref } from "react";
import { useLinkClick } from "../navigation.tsx";
import type { TripContext } from "./model.ts";

/** When the trip leaves, on the marina's clock: "Saturday, October 31, 2026 at 6:00 PM". */
export function tripWhen(trip: TripContext["trip"]): string {
  const start = formatTripTime(trip.localStartTime, trip.startsAt, trip.timeZone);
  return `${formatDate(trip.localDate, "full", { year: true })} at ${start}`;
}

/**
 * The booking page's band in the operator's color: a way back to the trips,
 * the trip's name as the page heading, and when it leaves.
 */
export function TripHeader({
  context,
  listing,
  titleRef,
}: {
  context: TripContext;
  listing: AvailableTrip | null;
  titleRef: Ref<HTMLHeadingElement>;
}) {
  const linkClick = useLinkClick();
  return (
    <section className="booking-hero" aria-labelledby="booking-title">
      <div className="guest-container booking-hero__inner">
        <a className="tap-target booking-hero__back" href="/" onClick={linkClick}>
          <Icon name="arrow-left" />
          All trips
        </a>
        <p className="booking-hero__eyebrow">Book a trip</p>
        <h1 id="booking-title" ref={titleRef} tabIndex={-1}>
          {context.productName}
        </h1>
        <p className="booking-hero__when">
          {tripWhen(context.trip)}
          {listing && (
            <>
              <span aria-hidden="true"> · {formatDuration(listing.durationMinutes)}</span>
              <span className="tg-visually-hidden">
                , for {formatDuration(listing.durationMinutes, "long")}
              </span>
            </>
          )}
        </p>
      </div>
    </section>
  );
}

function capacityText(listing: AvailableTrip): string {
  const { kind, total, remaining } = listing.capacity;
  if (kind === "whole_boat") return `Private charter: the whole boat, up to ${total} guests`;
  return `Shared trip, ${remaining} ${remaining === 1 ? "seat" : "seats"} left`;
}

/** The trip's facts beside the steps: where to meet, seats, the booking cutoff, and whose clock. */
export function TripFacts({
  context,
  listing,
}: {
  context: TripContext;
  listing: AvailableTrip | null;
}) {
  const zone = zoneCity(context.trip.timeZone);
  return (
    <section className="booking-facts" aria-labelledby="booking-facts-title">
      <h2 id="booking-facts-title" className="booking-facts__title">
        Trip details
      </h2>
      <ul className="booking-facts__list">
        {listing && (
          <>
            <li>
              <Icon name="map-pin" />
              <span>Meet at {listing.location.meetingPoint}</span>
            </li>
            <li>
              <Icon name={listing.capacity.kind === "seats" ? "users" : "boat"} />
              <span>{capacityText(listing)}</span>
            </li>
            <li>
              <Icon name="hourglass" />
              <span>Book by {formatCutoff(listing.salesCloseAt, listing)}</span>
            </li>
          </>
        )}
        <li>
          <Icon name="clock" />
          <span>
            Times are local to {listing ? listing.location.name : "the marina"} ({zone}).
          </span>
        </li>
      </ul>
    </section>
  );
}
