import type { PublicBrand } from "@tidegrid/contracts";
import { ButtonLink } from "@tidegrid/design-system/components";
import type { ReactNode } from "react";
import { ContactActions } from "../Contact.tsx";
import { useLinkClick } from "../navigation.tsx";
import { useTitle } from "../States.tsx";
import "./support.css";

/**
 * The guest support pages (G2.14b, D1(a), a coordinator default pending
 * owner confirmation): /support and /offline. Every tenant value is text or a
 * validated link, as in the rest of the shell. The copy is synthetic demo
 * content; the support hours are the platform's proposed pilot hours.
 */

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="support-section" aria-labelledby={`support-${id}`}>
      <h2 id={`support-${id}`} className="support-section__title">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A brand link: same-origin paths move in place, https links leave the site. */
function PolicyLink({ href, children }: { href: string; children: ReactNode }) {
  const linkClick = useLinkClick();
  return (
    <a href={href} onClick={href.startsWith("/") ? linkClick : undefined}>
      {children}
    </a>
  );
}

export function SupportPage({ brand }: { brand: PublicBrand }) {
  useTitle(`Help and support · ${brand.name}`);
  const linkClick = useLinkClick();
  return (
    <div className="guest-container guest-content guest-page support">
      <h1 tabIndex={-1}>Help and support</h1>
      <p className="support-lede">
        Questions about a trip, a booking, or a waiver go to {brand.name}. This is the TideGrid demo
        build: {brand.name} is a synthetic operator, and no booking made here is real.
      </p>

      <Section id="contact" title={`Contact ${brand.name}`}>
        <p>
          {brand.name} answers questions about trips, meeting points, weather calls, and changes to
          a booking.
        </p>
        <div className="booking-actions">
          <ContactActions brand={brand} />
        </div>
      </Section>

      <Section id="manage" title="Find or manage my booking">
        <p>
          Open the link in your confirmation email to see your booking, update your party's details,
          or cancel. A link works once, for three days. If yours has expired, open it anyway and
          choose "Email me a new link", and a fresh one goes to the address you booked with.
        </p>
        <ButtonLink variant="secondary" icon="calendar" href="/manage" onClick={linkClick}>
          Manage my booking
        </ButtonLink>
      </Section>

      <Section id="waivers" title="Waivers">
        <p>
          Each guest signs their own waiver from the link in their waiver email. The booking's page
          shows who has signed. If a waiver email is missing, check spam first, then contact{" "}
          {brand.name}.
        </p>
      </Section>

      <Section id="cancellations" title="Cancellations and refunds">
        <p>
          What a cancellation refunds depends on the cancellation policy shown at checkout. The{" "}
          <PolicyLink href={brand.legal.terms}>terms of booking</PolicyLink> cover the rest.
        </p>
      </Section>

      <Section id="about" title="About this booking site">
        <p>
          Online booking by TideGrid. Proposed platform support hours: 9:00 a.m. to 5:00 p.m.
          Eastern Time on US business days, by email. TideGrid runs the booking site; {brand.name}{" "}
          runs the trips.
        </p>
        <ul className="support-links">
          <li>
            <PolicyLink href={brand.legal.terms}>Terms of booking</PolicyLink>
          </li>
          <li>
            <PolicyLink href={brand.legal.privacy}>Privacy notice</PolicyLink>
          </li>
        </ul>
      </Section>
    </div>
  );
}

/**
 * /offline: what the booking site says about working without a connection.
 * It names no operator and shows no booking: the service worker's own
 * offline page (offline.html) is the one a guest sees with no network.
 */
export function OfflinePage() {
  useTitle("Using this site offline");
  const linkClick = useLinkClick();
  return (
    <div className="guest-container guest-content guest-page">
      <h1 tabIndex={-1}>Using this site offline</h1>
      <p>
        Booking needs a connection. Without one, this site shows a short offline page instead:
        nothing can be booked, paid, changed, or canceled until you're back online, and nothing on
        your phone confirms seats or a booking.
      </p>
      <ButtonLink variant="secondary" icon="arrow-left" href="/" onClick={linkClick}>
        Back to the trips
      </ButtonLink>
    </div>
  );
}
