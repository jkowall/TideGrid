import type { Membership, MeResponse } from "@tidegrid/contracts";
import {
  EmptyState,
  Icon,
  type IconName,
  Notice,
  StatusBadge,
} from "@tidegrid/design-system/components";
import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import { BookingDetailPage } from "./bookings/BookingDetail.tsx";
import { BookingsPage } from "./bookings/BookingsPage.tsx";
import { ExceptionsPage } from "./bookings/ExceptionsPage.tsx";
import { isUuid } from "./bookings/model.ts";
import { RosterPage } from "./bookings/RosterPage.tsx";
import { CalendarPage } from "./calendar/Calendar.tsx";
import { Wordmark } from "./Gate.tsx";
import { ConsoleLink, NavigationProvider } from "./navigation.tsx";
import { type FocusOnArrival, PageHeader } from "./PageHeader.tsx";
import { roleLabels } from "./roles.ts";

export { roleLabels } from "./roles.ts";

const sections: ReadonlyArray<{ path: string; label: string; icon: IconName }> = [
  { path: "/", label: "Overview", icon: "home" },
  { path: "/calendar", label: "Calendar", icon: "calendar" },
  { path: "/bookings", label: "Bookings", icon: "list" },
  { path: "/exceptions", label: "Exceptions", icon: "alert-triangle" },
];

/** The console's pages, by address. Ids in an address are UUIDs; anything else is not a page. */
export type Route =
  | { kind: "overview" }
  | { kind: "calendar" }
  | { kind: "bookings" }
  | { kind: "booking"; bookingId: string }
  | { kind: "exceptions" }
  | { kind: "roster"; tripId: string }
  | { kind: "not_found" };

const bookingPath = /^\/bookings\/([^/]+)$/;
const rosterPath = /^\/trips\/([^/]+)\/roster$/;

export function routeOf(path: string): Route {
  if (path === "/") return { kind: "overview" };
  if (path === "/calendar") return { kind: "calendar" };
  if (path === "/bookings") return { kind: "bookings" };
  if (path === "/exceptions") return { kind: "exceptions" };
  const booking = bookingPath.exec(path)?.[1];
  if (booking && isUuid(booking)) return { kind: "booking", bookingId: booking.toLowerCase() };
  const roster = rosterPath.exec(path)?.[1];
  if (roster && isUuid(roster)) return { kind: "roster", tripId: roster.toLowerCase() };
  return { kind: "not_found" };
}

/** The navigation section a page belongs to, and its title. */
const placeOf: Record<Route["kind"], { section: string | null; title: string }> = {
  overview: { section: "/", title: "Overview" },
  calendar: { section: "/calendar", title: "Calendar" },
  bookings: { section: "/bookings", title: "Bookings" },
  booking: { section: "/bookings", title: "Booking" },
  roster: { section: "/bookings", title: "Roster" },
  exceptions: { section: "/exceptions", title: "Payment exceptions" },
  not_found: { section: null, title: "Not found" },
};

/**
 * Pathname routing for the shell. The console Worker serves the app for any
 * path. `moved` turns true once the person changes page, by the navigation, a
 * link, or the browser's back and forward buttons. `visit` counts those
 * changes, so every one opens its page afresh: a page may move its own
 * address within itself (the list's day, the calendar's week), and a link to
 * the address it was opened at must still open it anew. A link to the very
 * address already showing changes nothing.
 */
function usePath(): {
  path: string;
  visit: number;
  moved: boolean;
  navigate: (to: string) => void;
} {
  const [at, setAt] = useState(() => ({ path: window.location.pathname, visit: 0 }));
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    const onPop = () => {
      setAt((current) => ({ path: window.location.pathname, visit: current.visit + 1 }));
      setMoved(true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    const url = new URL(to, window.location.origin);
    const address = `${url.pathname}${url.search}`;
    if (address === `${window.location.pathname}${window.location.search}`) return;
    window.history.pushState(null, "", `${address}${url.hash}`);
    setAt((current) => ({ path: url.pathname, visit: current.visit + 1 }));
    setMoved(true);
    // A new page starts at its top, as a page load would. Back and Forward
    // keep the browser's own scroll restoration.
    (document.scrollingElement ?? document.documentElement).scrollTop = 0;
  }, []);
  return { path: at.path, visit: at.visit, moved, navigate };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

function ScopePicker({
  memberships,
  selected,
  onSelect,
}: {
  memberships: Membership[];
  selected: Membership;
  onSelect: (tenantId: string) => void;
}) {
  if (memberships.length === 1) {
    return (
      <div className="console-scope">
        <p className="console-scope__label">Operator</p>
        <p className="console-scope__single">{selected.tenantName}</p>
      </div>
    );
  }
  return (
    <div className="console-scope">
      <label className="console-scope__label" htmlFor="console-scope">
        Operator
      </label>
      <div className="console-scope__control">
        <select
          id="console-scope"
          value={selected.tenantId}
          onChange={(e) => onSelect(e.target.value)}
        >
          {memberships.map((m) => (
            <option key={m.tenantId} value={m.tenantId}>
              {m.tenantName}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" className="console-scope__chevron" />
      </div>
    </div>
  );
}

function Overview({
  me,
  selected,
  focusHeading,
}: { me: MeResponse; selected: Membership } & FocusOnArrival) {
  const { principal, memberships } = me;
  return (
    <>
      <PageHeader eyebrow={selected.tenantName} title="Overview" focusHeading={focusHeading} />
      <div className="console-grid">
        <section className="console-card" aria-labelledby="access-title">
          <h2 id="access-title">Your access</h2>
          <dl className="console-dl">
            <dt>Name</dt>
            <dd>{principal.displayName}</dd>
            <dt>Email</dt>
            <dd className="console-dl__wrap">{principal.email}</dd>
            <dt>Signed in with</dt>
            <dd>
              {principal.authMethod === "access" ? "Cloudflare Access" : "Email sign-in link"}
            </dd>
            <dt>Role here</dt>
            <dd>{roleLabels[selected.role]}</dd>
          </dl>
        </section>
        <section className="console-card" aria-labelledby="operators-title">
          <h2 id="operators-title">Your operators</h2>
          <ul className="console-list">
            {memberships.map((m) => {
              const current = m.tenantId === selected.tenantId;
              return (
                <li
                  key={m.tenantId}
                  className="console-list__item"
                  aria-current={current ? "true" : undefined}
                >
                  <div className="console-list__main">
                    <span className="console-list__title">
                      {m.tenantName}
                      {/* A real space, so a screen reader does not run the words together. */}
                      {current && (
                        <>
                          {" "}
                          <span className="console-list__selected">Selected</span>
                        </>
                      )}
                    </span>
                    <span className="console-list__meta">
                      {m.tenantSlug} · {roleLabels[m.role]}
                    </span>
                  </div>
                  <StatusBadge tone="ready">Active</StatusBadge>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}

function Placeholder({
  selected,
  title,
  icon,
  heading,
  body,
  focusHeading,
}: {
  selected: Membership;
  title: string;
  icon: IconName;
  heading: string;
  body: string;
} & FocusOnArrival) {
  return (
    <>
      <PageHeader eyebrow={selected.tenantName} title={title} focusHeading={focusHeading} />
      <EmptyState icon={icon} title={heading}>
        <p>{body}</p>
      </EmptyState>
    </>
  );
}

export function ConsoleShell({
  me,
  signOut,
  signOutFailed = false,
  focusHeading = false,
}: {
  me: MeResponse;
  /** The sign-out control. It sits in the rail's user block at every width. */
  signOut: ReactNode;
  /** The last sign-out did not reach the API; the person is still signed in. */
  signOutFailed?: boolean;
  /** The shell replaced a screen the person acted on, so the first page's heading takes focus. */
  focusHeading?: boolean;
}) {
  const { path, visit, moved, navigate } = usePath();
  const { principal, memberships } = me;
  const [scopeId, setScopeId] = useState(memberships[0]?.tenantId);
  // Switching operators on a page restarts pages keyed on the operator. Their
  // headings must not take focus then: the person is still in the picker, and
  // moving them away on a change of value would be a surprise.
  const [switchedOn, setSwitchedOn] = useState<number | null>(null);
  useEffect(() => {
    void visit;
    setSwitchedOn(null);
  }, [visit]);
  const focusPage = switchedOn !== visit && (focusHeading || moved);
  const selectScope = (tenantId: string) => {
    // A trip filter names one operator's trip; the next operator's list starts
    // from every trip.
    const params = new URLSearchParams(window.location.search);
    if (params.has("trip")) {
      params.delete("trip");
      const search = params.toString() ? `?${params}` : "";
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search}${window.location.hash}`,
      );
    }
    setScopeId(tenantId);
    setSwitchedOn(visit);
  };
  const selected = memberships.find((m) => m.tenantId === scopeId) ?? memberships[0];
  const route = routeOf(path);
  const place = placeOf[route.kind];
  useDocumentTitle(`${place.title} · ${selected?.tenantName ?? "Operator console"} · TideGrid`);
  // The app routes a person with no active membership to the not-provisioned screen.
  if (!selected) return null;

  // Every page but the overview is keyed on the operator: another operator's
  // week, list, booking, or roster starts from nothing.
  let page: ReactNode;
  switch (route.kind) {
    case "overview":
      page = <Overview me={me} selected={selected} focusHeading={focusPage} />;
      break;
    case "calendar":
      page = (
        <CalendarPage key={selected.tenantId} membership={selected} focusHeading={focusPage} />
      );
      break;
    case "bookings":
      page = (
        <BookingsPage key={selected.tenantId} membership={selected} focusHeading={focusPage} />
      );
      break;
    case "booking":
      page = (
        <BookingDetailPage
          key={selected.tenantId}
          membership={selected}
          bookingId={route.bookingId}
          focusHeading={focusPage}
        />
      );
      break;
    case "exceptions":
      page = (
        <ExceptionsPage key={selected.tenantId} membership={selected} focusHeading={focusPage} />
      );
      break;
    case "roster":
      page = (
        <RosterPage
          key={selected.tenantId}
          membership={selected}
          tripId={route.tripId}
          focusHeading={focusPage}
        />
      );
      break;
    case "not_found":
      page = (
        <Placeholder
          selected={selected}
          title="Page not found"
          icon="compass"
          heading="This page isn't part of the console"
          body="Choose a section from the navigation to continue."
          focusHeading={focusPage}
        />
      );
      break;
  }

  return (
    <NavigationProvider navigate={navigate}>
      <div className="console-layout">
        <a className="tg-skip-link" href="#console-main">
          Skip to content
        </a>
        <aside className="console-rail">
          <div className="console-rail__top">
            <Wordmark />
          </div>
          <ScopePicker memberships={memberships} selected={selected} onSelect={selectScope} />
          <nav className="console-nav" aria-label="Console">
            <ul>
              {sections.map((s) => (
                <li key={s.path}>
                  <ConsoleLink
                    href={s.path}
                    // The page itself is "page"; a page inside the section, such
                    // as one booking, marks the section "true".
                    aria-current={
                      s.path === path ? "page" : s.path === place.section ? "true" : undefined
                    }
                  >
                    <Icon name={s.icon} />
                    {s.label}
                  </ConsoleLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="console-rail__user">
            <div className="console-rail__identity">
              <span className="console-avatar" aria-hidden="true">
                {initials(principal.displayName)}
              </span>
              <span className="console-rail__who">
                <span className="console-rail__name">{principal.displayName}</span>
                <span className="console-rail__email">{principal.email}</span>
              </span>
            </div>
            {signOut}
          </div>
        </aside>
        <main id="console-main" className="console-main" tabIndex={-1}>
          {signOutFailed && (
            <Notice tone="error" title="Sign-out didn't finish" className="console-main__notice">
              <p>You're still signed in. Check your connection, then choose Sign out again.</p>
            </Notice>
          )}
          {/* Keyed on the visit: every page change mounts a new page, so its
            heading takes focus even between two pages built alike. */}
          <Fragment key={visit}>{page}</Fragment>
        </main>
      </div>
    </NavigationProvider>
  );
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
