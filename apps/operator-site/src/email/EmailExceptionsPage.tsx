import type { EmailException, Membership } from "@tidegrid/contracts";
import {
  Button,
  EmptyState,
  Notice,
  Skeleton,
  StatusBadge,
  VisuallyHidden,
} from "@tidegrid/design-system/components";
import { useEffect, useRef, useState } from "react";
import { instantText } from "../bookings/model.ts";
import { canRetry, ReadFailed } from "../bookings/States.tsx";
import { focusIsLost } from "../focus.ts";
import type { ReadFailure } from "../http.ts";
import { ConsoleButtonLink, ConsoleLink } from "../navigation.tsx";
import { type FocusOnArrival, PageHeader } from "../PageHeader.tsx";
import { roleNames } from "../roles.ts";
import { loadEmailExceptions, type EmailExceptionsPage as Page } from "./api.ts";
import {
  canSeeEmailExceptions,
  exceptionName,
  exceptionStateView,
  followUpHref,
  followUpText,
  stoppedText,
} from "./exceptions.ts";
import { failureText } from "./model.ts";
import "./email.css";

/**
 * The operator's email exceptions (W1-EMAIL-EXC, a follow-up to G2.16b D9 A):
 * every email that stopped without the email service taking it, newest first,
 * a page at a time. Each says what it was, how it ended, when, after how many
 * attempts, and the last error, and links to its booking's Email card (or
 * Waivers card, for a waiver request), where staff check the address and send
 * it again. Owners and booking staff only; finance gets a designed refusal and
 * no request.
 */

type Load =
  | { kind: "loading" }
  | { kind: "ready"; page: Page; more: "idle" | "loading" | "failed" }
  | { kind: "failed"; reason: ReadFailure; failures: number; retrying: boolean };

export function EmailExceptionsPage({
  membership,
  focusHeading,
}: { membership: Membership } & FocusOnArrival) {
  if (!canSeeEmailExceptions(membership.role)) {
    return (
      <>
        <PageHeader
          eyebrow={membership.tenantName}
          title="Email exceptions"
          focusHeading={focusHeading}
        />
        <EmptyState
          icon="lock"
          title="Your role can't see email exceptions"
          actions={
            <ConsoleButtonLink href="/bookings" icon="list">
              Go to bookings
            </ConsoleButtonLink>
          }
        >
          <p>
            Following up a guest's email is for owners and booking staff. Your role,{" "}
            {roleNames[membership.role]}, sees bookings, totals, and payments on Bookings.
          </p>
        </EmptyState>
      </>
    );
  }
  return <ExceptionsList membership={membership} focusHeading={focusHeading} />;
}

function ExceptionsList({ membership, focusHeading }: { membership: Membership } & FocusOnArrival) {
  const { tenantId, tenantName } = membership;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retryRequested = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  /** Try again went with its notice: the page's heading takes focus. */
  const focusHeadingOnLoad = useRef(false);
  /** Show older went with the last page: the first older exception takes focus. */
  const focusExceptionId = useRef<string | null>(null);

  useEffect(() => {
    void attempt;
    const controller = new AbortController();
    const retry = retryRequested.current;
    retryRequested.current = false;
    setLoad((current) =>
      retry && current.kind === "failed" ? { ...current, retrying: true } : { kind: "loading" },
    );
    void loadEmailExceptions(tenantId, {}, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      focusHeadingOnLoad.current = retry && (result.kind === "ok" || !canRetry(result.reason));
      if (result.kind === "ok") {
        setLoad({ kind: "ready", page: result.value, more: "idle" });
        return;
      }
      setLoad((current) => ({
        kind: "failed",
        reason: result.reason,
        failures: current.kind === "failed" ? current.failures + 1 : 1,
        retrying: false,
      }));
    });
    return () => controller.abort();
  }, [tenantId, attempt]);

  // Focus moves on only from a control that went away with the change, never
  // from where the person has moved it while the page loaded.
  useEffect(() => {
    if (load.kind === "loading") return;
    const toHeading = focusHeadingOnLoad.current;
    focusHeadingOnLoad.current = false;
    let first: string | null = null;
    if (load.kind === "ready") {
      first = focusExceptionId.current;
      focusExceptionId.current = null;
    }
    if ((!toHeading && first === null) || !focusIsLost()) return;
    const older = !toHeading && first ? document.getElementById(itemHeadingId(first)) : null;
    (older ?? heading.current)?.focus();
  }, [load]);

  const loadOlder = () => {
    if (load.kind !== "ready" || !load.page.nextBefore) return;
    const before = load.page.nextBefore;
    setLoad({ ...load, more: "loading" });
    void loadEmailExceptions(tenantId, { before }).then((result) => {
      setLoad((current) => {
        if (current.kind !== "ready" || current.page.nextBefore !== before) return current;
        if (result.kind !== "ok") return { ...current, more: "failed" };
        // The button the person pressed goes with the last page; the first
        // older exception takes focus, so their place is kept.
        if (result.value.nextBefore === null) {
          focusExceptionId.current = result.value.exceptions[0]?.id ?? "";
        }
        return {
          kind: "ready",
          more: "idle",
          page: {
            exceptions: [...current.page.exceptions, ...result.value.exceptions],
            nextBefore: result.value.nextBefore,
          },
        };
      });
    });
  };

  const exceptions = load.kind === "ready" ? load.page.exceptions : [];
  const count =
    exceptions.length === 1 ? "1 email exception" : `${exceptions.length} email exceptions`;
  return (
    <>
      <PageHeader
        eyebrow={tenantName}
        title="Email exceptions"
        focusHeading={focusHeading}
        headingRef={heading}
      />
      <div className="ex ee">
        <p className="ex-lede">
          Email that stopped without the email service taking it, newest first. TideGrid doesn't try
          these again on its own. Open each one's booking to check the address and send it again.
        </p>
        <p className="tg-visually-hidden" role="status">
          {load.kind === "loading"
            ? "Loading email exceptions…"
            : load.kind === "ready"
              ? exceptions.length === 0
                ? "No email exceptions."
                : `${count}${load.page.nextBefore ? " shown, with older ones to load" : ""}.`
              : ""}
        </p>
        {load.kind === "loading" && <ExceptionsSkeleton />}
        {load.kind === "failed" && (
          <ReadFailed
            className="bk-notice"
            reason={load.reason}
            noun="email exceptions"
            tenantName={tenantName}
            failures={load.failures}
            retrying={load.retrying}
            onRetry={() => {
              retryRequested.current = true;
              setAttempt((n) => n + 1);
            }}
          />
        )}
        {load.kind === "ready" &&
          (exceptions.length === 0 ? (
            <EmptyState icon="check-circle" title="No email exceptions">
              <p>
                Every email {tenantName} sent was taken by the email service, or is still being
                tried. An email that stops for good shows here, so it can be followed up.
              </p>
            </EmptyState>
          ) : (
            <ul className="ex-list">
              {exceptions.map((e) => (
                <ExceptionItem key={e.id} exception={e} />
              ))}
            </ul>
          ))}
        {load.kind === "ready" && load.page.nextBefore && (
          <div className="bk-more">
            {load.more === "failed" && (
              <Notice tone="error" className="bk-notice" title="Older email exceptions didn't load">
                <p>Check your connection, then try again.</p>
              </Notice>
            )}
            <Button busy={load.more === "loading"} busyLabel="Loading older…" onClick={loadOlder}>
              {load.more === "failed" ? "Try again" : "Show older email exceptions"}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

const itemHeadingId = (id: string) => `email-exception-${id}`;

function ExceptionItem({ exception: e }: { exception: EmailException }) {
  const state = exceptionStateView(e.state);
  const zone = e.booking?.timeZone ?? "UTC";
  const href = followUpHref(e);
  const linkText = followUpText(e);
  return (
    <li className="ex-item ee-item" data-tone={e.laterSent ? "info" : state.tone}>
      <div className="ex-item__head">
        <h2 className="ex-item__title" id={itemHeadingId(e.id)} tabIndex={-1}>
          {exceptionName(e)}
          {e.staffResend && (
            <>
              <VisuallyHidden>, </VisuallyHidden>
              <span className="em-tag">Sent again by staff</span>
            </>
          )}
        </h2>
        <StatusBadge tone={state.tone} icon={state.icon}>
          {state.label}
        </StatusBadge>
      </div>
      <p className="ex-item__detail">{failureText(e.failureCode, e.template)}</p>
      {e.laterSent && (
        <p className="ex-item__detail ee-later">
          A later {exceptionName(e).toLowerCase()} for this booking was taken by the email service.
          That doesn't mean the guest read it.
        </p>
      )}
      <dl className="console-dl ex-item__facts">
        <dt>Follow up on</dt>
        <dd>
          {href && linkText ? (
            <ConsoleLink href={href} className="tap-target ee-item__link">
              {linkText}
            </ConsoleLink>
          ) : (
            "No booking"
          )}
        </dd>
        <dt>Stopped</dt>
        <dd>{stoppedText(e, (iso) => instantText(iso, zone))}</dd>
        <dt>Last error</dt>
        <dd>
          <code className="ee-code">{e.failureCode}</code>
        </dd>
      </dl>
    </li>
  );
}

function ExceptionsSkeleton() {
  return (
    <div className="ex-list ex-list--skeleton" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="ex-item">
          <Skeleton width="min(20rem, 70%)" height="1.5rem" />
          <Skeleton variant="text" width="min(32rem, 95%)" />
          <Skeleton variant="text" width="min(18rem, 60%)" />
        </div>
      ))}
    </div>
  );
}
