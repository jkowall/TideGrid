import type { PublicBrand } from "@tidegrid/contracts";
import { ButtonLink, Icon } from "@tidegrid/design-system/components";
import { type ReactNode, useEffect, useRef } from "react";
import { tripIdOf } from "./booking/address.ts";
import { BookingPage } from "./booking/BookingPage.tsx";
import { formatPhone, type Tenant } from "./bootstrap.ts";
import { useLinkClick } from "./navigation.tsx";
import { useTitle } from "./States.tsx";
import { UpcomingTrips } from "./UpcomingTrips.tsx";

/**
 * The branded guest frame. Every tenant value reaches the page as text, as an
 * attribute React escapes, or as a validated data URI shown only as an image
 * (an `<img>` element or the tab icon). Tenant data never becomes markup, a
 * style, or a script.
 */

const legalPages: Record<string, { title: string; placeholder: string }> = {
  "/legal/terms": { title: "Terms of booking", placeholder: "These terms are a placeholder" },
  "/legal/privacy": { title: "Privacy notice", placeholder: "This notice is a placeholder" },
};

type Page =
  | { kind: "home" }
  | { kind: "book"; tripId: string }
  | { kind: "legal"; title: string; placeholder: string }
  | { kind: "not-found" };

function pageFor(path: string): Page {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (clean === "/") return { kind: "home" };
  const tripId = tripIdOf(clean);
  if (tripId) return { kind: "book", tripId };
  const legal = Object.hasOwn(legalPages, clean) ? legalPages[clean] : undefined;
  if (legal) return { kind: "legal", ...legal };
  return { kind: "not-found" };
}

function BrandLockup({ brand }: { brand: PublicBrand }) {
  const logo = brand.logo;
  if (logo?.kind === "lockup") {
    return (
      <img
        className="guest-brand__lockup"
        src={logo.src}
        alt={logo.alt}
        width={logo.width}
        height={logo.height}
      />
    );
  }
  return (
    <>
      {logo && (
        <img
          className="guest-brand__mark"
          src={logo.src}
          alt=""
          width={logo.width}
          height={logo.height}
        />
      )}
      <span className="guest-brand__name">{brand.name}</span>
    </>
  );
}

function Home({ brand }: { brand: PublicBrand }) {
  useTitle(brand.name);
  return (
    <>
      <section className="guest-hero" aria-labelledby="hero-title">
        <div className="guest-container guest-hero__inner">
          <div className="guest-hero__text">
            <p className="guest-hero__eyebrow">Book online</p>
            <h1 id="hero-title" tabIndex={-1}>
              {brand.name}
            </h1>
            {brand.tagline && <p className="guest-hero__tagline">{brand.tagline}</p>}
          </div>
          {brand.logo?.kind === "mark" && (
            <img
              className="guest-hero__mark"
              src={brand.logo.src}
              alt=""
              width={brand.logo.width}
              height={brand.logo.height}
            />
          )}
        </div>
        <svg
          className="guest-hero__waves"
          viewBox="0 0 1200 48"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M0 30c100 0 100-18 200-18s100 18 200 18 100-18 200-18 100 18 200 18 100-18 200-18 100 18 200 18" />
          <path d="M0 42c100 0 100-12 200-12s100 12 200 12 100-12 200-12 100 12 200 12 100-12 200-12 100 12 200 12" />
        </svg>
      </section>
      <div className="guest-container guest-content">
        <UpcomingTrips />
      </div>
    </>
  );
}

function PageFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="guest-container guest-content guest-page">
      <h1 tabIndex={-1}>{title}</h1>
      {children}
    </div>
  );
}

function LegalPage({
  brand,
  title,
  placeholder,
}: {
  brand: PublicBrand;
  title: string;
  placeholder: string;
}) {
  useTitle(`${title} · ${brand.name}`);
  const linkClick = useLinkClick();
  return (
    <PageFrame title={title}>
      <p>
        {brand.name} is a synthetic operator in the TideGrid demo build. {placeholder}: no booking
        made here is real, and no money moves. Checkout keeps the name and email typed into it with
        the test booking, so use made-up details.
      </p>
      <ButtonLink variant="secondary" icon="arrow-left" href="/" onClick={linkClick}>
        Back to {brand.name}
      </ButtonLink>
    </PageFrame>
  );
}

function NotFoundPage({ brand }: { brand: PublicBrand }) {
  useTitle(`Page not found · ${brand.name}`);
  const linkClick = useLinkClick();
  return (
    <PageFrame title="Page not found">
      <p>
        That page isn't part of the booking site for {brand.name}. It may have moved, or the link
        may be mistyped.
      </p>
      <ButtonLink variant="primary" icon="arrow-left" href="/" onClick={linkClick}>
        Back to {brand.name}
      </ButtonLink>
    </PageFrame>
  );
}

function Footer({ brand }: { brand: PublicBrand }) {
  const { phone, email, website } = brand.contact;
  return (
    <footer className="guest-footer">
      <div className="guest-container">
        <div className="guest-footer__grid">
          <div>
            <p className="guest-footer__name">{brand.name}</p>
            {brand.tagline && <p className="guest-footer__tagline">{brand.tagline}</p>}
          </div>
          <div>
            <h2 className="tg-eyebrow">Contact</h2>
            <ul className="guest-footer__list">
              {phone && (
                <li>
                  <a className="tap-target guest-footer__link" href={`tel:${phone}`}>
                    <Icon name="phone" />
                    {formatPhone(phone)}
                  </a>
                </li>
              )}
              {email && (
                <li>
                  <a className="tap-target guest-footer__link" href={`mailto:${email}`}>
                    <Icon name="mail" />
                    {email}
                  </a>
                </li>
              )}
              {website && (
                <li>
                  <a className="tap-target guest-footer__link" href={website}>
                    <Icon name="globe" />
                    Website
                  </a>
                </li>
              )}
            </ul>
          </div>
          <nav aria-label="Legal">
            <h2 className="tg-eyebrow">Policies</h2>
            <ul className="guest-footer__list">
              <li>
                <a className="tap-target guest-footer__link" href={brand.legal.terms}>
                  Terms of booking
                </a>
              </li>
              <li>
                <a className="tap-target guest-footer__link" href={brand.legal.privacy}>
                  Privacy notice
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="guest-footer__meta">
          <p>Online booking by TideGrid. Demo build: this operator and its trips are synthetic.</p>
        </div>
      </div>
    </footer>
  );
}

export function BrandedShell({
  tenant,
  brand,
  path,
  focusHeading = false,
}: {
  tenant: Tenant;
  brand: PublicBrand;
  path: string;
  /** Move focus to the page heading on arrival, when the control the person used is gone. */
  focusHeading?: boolean;
}) {
  const page = pageFor(path);
  const phone = brand.contact.phone;
  const main = useRef<HTMLElement>(null);
  const linkClick = useLinkClick();
  // Mount only: the first render decides. The shell mounts afresh after "Try
  // again" and after each move between pages. A booking page has no heading
  // until its trip loads, so it moves focus itself.
  useEffect(() => {
    if (focusHeading && page.kind !== "book") {
      main.current?.querySelector<HTMLElement>("h1")?.focus();
    }
  }, []);
  return (
    <div className="guest" data-tenant={tenant.slug}>
      <a className="tg-skip-link" href="#main">
        Skip to content
      </a>
      <header className="guest-header">
        <div className="guest-container guest-header__inner">
          <a className="guest-brand" href="/" onClick={linkClick}>
            <BrandLockup brand={brand} />
          </a>
          {phone && (
            <a
              className="tap-target guest-header__call"
              href={`tel:${phone}`}
              aria-label={`Call ${formatPhone(phone)}`}
            >
              <Icon name="phone" />
              <span className="guest-header__call-short">Call</span>
              <span className="guest-header__call-long">{formatPhone(phone)}</span>
            </a>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1} ref={main}>
        {page.kind === "home" && <Home brand={brand} />}
        {page.kind === "book" && (
          <BookingPage brand={brand} tripId={page.tripId} focusOnArrival={focusHeading} />
        )}
        {page.kind === "legal" && (
          <LegalPage brand={brand} title={page.title} placeholder={page.placeholder} />
        )}
        {page.kind === "not-found" && <NotFoundPage brand={brand} />}
      </main>
      <Footer brand={brand} />
    </div>
  );
}
