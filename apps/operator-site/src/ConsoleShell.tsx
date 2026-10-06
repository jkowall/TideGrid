import type { Membership, MeResponse } from "@tidegrid/contracts";
import {
  EmptyState,
  Icon,
  type IconName,
  Notice,
  StatusBadge,
} from "@tidegrid/design-system/components";
import { Fragment, type MouseEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { CalendarPage } from "./calendar/Calendar.tsx";
import { Wordmark } from "./Gate.tsx";
import { type FocusOnArrival, PageHeader } from "./PageHeader.tsx";
import { roleLabels } from "./roles.ts";

export { roleLabels } from "./roles.ts";

const sections: ReadonlyArray<{ path: string; label: string; icon: IconName }> = [
  { path: "/", label: "Overview", icon: "home" },
  { path: "/calendar", label: "Calendar", icon: "calendar" },
  { path: "/bookings", label: "Bookings", icon: "list" },
];

/**
 * Pathname routing for the shell. The console Worker serves the app for any
 * path. `moved` turns true once the person changes page, by the navigation or
 * the browser's back and forward buttons.
 */
function usePath(): { path: string; moved: boolean; navigate: (to: string) => void } {
  const [path, setPath] = useState(() => window.location.pathname);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
      setMoved(true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
    setMoved(true);
  }, []);
  return { path, moved, navigate };
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
  const { path, moved, navigate } = usePath();
  const { principal, memberships } = me;
  const [scopeId, setScopeId] = useState(memberships[0]?.tenantId);
  // Switching operators on a page restarts pages keyed on the operator. Their
  // headings must not take focus then: the person is still in the picker, and
  // moving them away on a change of value would be a surprise.
  const [switchedOn, setSwitchedOn] = useState<string | null>(null);
  useEffect(() => {
    void path;
    setSwitchedOn(null);
  }, [path]);
  const focusPage = switchedOn !== path && (focusHeading || moved);
  const selectScope = (tenantId: string) => {
    setScopeId(tenantId);
    setSwitchedOn(path);
  };
  const selected = memberships.find((m) => m.tenantId === scopeId) ?? memberships[0];
  const current = sections.find((s) => s.path === path);
  useDocumentTitle(
    `${current?.label ?? "Not found"} · ${selected?.tenantName ?? "Operator console"} · TideGrid`,
  );
  // The app routes a person with no active membership to the not-provisioned screen.
  if (!selected) return null;

  const follow = (event: MouseEvent<HTMLAnchorElement>, to: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (to !== path) navigate(to);
  };

  let page: ReactNode;
  if (path === "/") {
    page = <Overview me={me} selected={selected} focusHeading={focusPage} />;
  } else if (path === "/calendar") {
    // Keyed on the operator: another operator's week starts from nothing.
    page = <CalendarPage key={selected.tenantId} membership={selected} focusHeading={focusPage} />;
  } else if (path === "/bookings") {
    page = (
      <Placeholder
        selected={selected}
        title="Bookings"
        icon="list"
        heading="The booking list isn't here yet"
        body={`The list of bookings for ${selected.tenantName} comes in a later build. Booked and held seats show on the calendar.`}
        focusHeading={focusPage}
      />
    );
  } else {
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
  }

  return (
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
                <a
                  href={s.path}
                  aria-current={s.path === path ? "page" : undefined}
                  onClick={(e) => follow(e, s.path)}
                >
                  <Icon name={s.icon} />
                  {s.label}
                </a>
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
        {/* Keyed on the path: every page change mounts a new page, so its
            heading takes focus even between two pages built alike. */}
        <Fragment key={path}>{page}</Fragment>
      </main>
    </div>
  );
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
