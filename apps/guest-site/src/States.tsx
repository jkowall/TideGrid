import { Button, Icon, type IconName, Skeleton } from "@tidegrid/design-system/components";
import { type ReactNode, useEffect, useRef } from "react";
import type { Tenant } from "./bootstrap.ts";
import { TripListSkeleton } from "./UpcomingTrips.tsx";

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/**
 * Neutral frame for every screen that has no tenant brand to show. It uses
 * surface tokens only, so nothing here can be mistaken for an operator's page.
 */
function NeutralFrame({ children }: { children: ReactNode }) {
  return (
    <div className="guest guest--neutral">
      <main id="main" className="guest-state">
        {children}
      </main>
      <footer className="guest-state__footer">
        <p>Online booking by TideGrid. Demo build with synthetic operators.</p>
      </footer>
    </div>
  );
}

function StatePanel({
  icon,
  tone = "neutral",
  title,
  children,
  action,
}: {
  icon: IconName;
  tone?: "neutral" | "warning";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  // These screens replace the loading state; moving focus to the heading is
  // what makes a screen reader say what happened.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="guest-state__panel">
      <div className={`guest-state__icon guest-state__icon--${tone}`}>
        <Icon name={icon} />
      </div>
      <h1 className="guest-state__title" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <div className="guest-state__body">{children}</div>
      {action && <div className="guest-state__action">{action}</div>}
    </div>
  );
}

export function LoadingState() {
  useTitle("Loading booking site");
  return (
    <div className="guest guest--neutral" aria-busy="true">
      <p className="tg-visually-hidden" role="status">
        Loading booking site…
      </p>
      <div className="guest-header" aria-hidden="true">
        <div className="guest-container guest-header__inner">
          <span className="guest-brand">
            <Skeleton variant="circle" width="2.5rem" height="2.5rem" />
            <Skeleton variant="text" width="10rem" />
          </span>
          <Skeleton width="7rem" height="1.25rem" />
        </div>
      </div>
      <div className="guest-hero guest-hero--skeleton" aria-hidden="true">
        <div className="guest-container">
          <Skeleton width="6rem" height="0.75rem" />
          <Skeleton className="guest-skeleton-title" width="min(28rem, 80%)" height="2.75rem" />
          <Skeleton variant="text" width="min(22rem, 70%)" />
        </div>
      </div>
      {/* The shape of the trips section, so the page does not jump when it loads. */}
      <div className="guest-container guest-content" aria-hidden="true">
        <div className="trips">
          <Skeleton width="14rem" height="2rem" />
          <Skeleton width="100%" height="7.5rem" />
          <Skeleton width="100%" height="5.5rem" />
          <TripListSkeleton />
        </div>
      </div>
    </div>
  );
}

export function NotPublishedState({ host }: { host: string }) {
  useTitle("Booking site not found");
  return (
    <NeutralFrame>
      <StatePanel icon="compass" title="There's no booking site at this address">
        <p>
          We couldn't find an operator at <strong className="guest-state__host">{host}</strong>.
          Check the link you followed, or contact the business you're booking with.
        </p>
      </StatePanel>
    </NeutralFrame>
  );
}

export function NotReadyState({ tenant }: { tenant: Tenant }) {
  useTitle(`${tenant.name}: booking not open yet`);
  return (
    <NeutralFrame>
      <StatePanel icon="clock" title="This booking site isn't open yet">
        <p>{tenant.name} hasn't opened online booking yet. Check back soon.</p>
      </StatePanel>
    </NeutralFrame>
  );
}

/**
 * Shown by the error boundary when the page itself fails to render. "Try
 * again" starts the page afresh without its query, so an address that caused
 * the failure cannot cause it again.
 */
export function CrashedState() {
  useTitle("Booking site unavailable");
  return (
    <NeutralFrame>
      <StatePanel
        icon="alert-triangle"
        tone="warning"
        title="Something went wrong on this page"
        action={
          <Button
            variant="primary"
            icon="refresh"
            onClick={() => window.location.assign(window.location.pathname)}
          >
            Try again
          </Button>
        }
      >
        <p>Try again. If it keeps happening, the booking site may be briefly unavailable.</p>
      </StatePanel>
    </NeutralFrame>
  );
}

export function FailedState({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  useTitle("Booking site unavailable");
  return (
    <NeutralFrame>
      <StatePanel
        icon="alert-triangle"
        tone="warning"
        title="We couldn't load this booking site"
        action={
          <Button
            variant="primary"
            icon="refresh"
            busy={retrying}
            busyLabel="Trying again…"
            onClick={onRetry}
          >
            Try again
          </Button>
        }
      >
        <p role="status">
          {retrying
            ? "Connecting to the booking site…"
            : "Check your connection and try again. If it keeps happening, the site may be briefly unavailable."}
        </p>
      </StatePanel>
    </NeutralFrame>
  );
}
