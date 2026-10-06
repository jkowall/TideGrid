import { Button, ButtonLink, Notice } from "@tidegrid/design-system/components";
import type { ReactNode } from "react";
import type { ReadFailure } from "../http.ts";

/**
 * Why a booking view did not load, in plain words, with the one way forward:
 * sign in again, try again, or nothing to do here. Shared by the list, a
 * booking, the roster, and the exceptions.
 */
export function failureText(
  reason: ReadFailure,
  what: { noun: string; tenantName: string },
): { title: string; body: string } {
  switch (reason) {
    case "signed_out":
      return { title: "You're signed out", body: `Sign in again to see ${what.noun}.` };
    case "forbidden":
      return {
        title: `Your role can't see ${what.noun}`,
        body: `Ask an owner of ${what.tenantName} if you need access.`,
      };
    case "suspended":
      return {
        title: "This operator is suspended",
        body: `While ${what.tenantName} is suspended, ${what.noun} can't be shown.`,
      };
    case "no_access":
      return {
        title: "You no longer have access to this operator",
        body: `Your membership of ${what.tenantName} may have ended. Ask one of its owners.`,
      };
    case "not_found":
      return {
        title: `${capitalize(what.noun)} couldn't be found`,
        body: `${what.tenantName} has nothing at this address. Go back to bookings and try again from there.`,
      };
    case "rejected":
      return {
        title: `${capitalize(what.noun)} can't be shown for this address`,
        body: "Go back to today and try again from there.",
      };
    case "unreadable":
      return {
        title: `${capitalize(what.noun)} couldn't be shown`,
        body: "TideGrid sent something this console can't read. Try again in a moment.",
      };
    case "unreachable":
      return {
        title: "The console can't reach TideGrid",
        body: "Check your connection, then try again.",
      };
    case "unavailable":
      return {
        title: `${capitalize(what.noun)} didn't load`,
        body: "TideGrid isn't responding right now. Try again in a moment.",
      };
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const canRetry = (reason: ReadFailure) =>
  reason === "unreachable" || reason === "unavailable" || reason === "unreadable";

export function ReadFailed({
  reason,
  noun,
  tenantName,
  failures = 1,
  retrying = false,
  onRetry,
  otherAction,
  className,
}: {
  reason: ReadFailure;
  noun: string;
  tenantName: string;
  failures?: number;
  retrying?: boolean;
  onRetry?: () => void;
  /** The way forward when trying again cannot help, such as "Go to today". */
  otherAction?: ReactNode;
  className?: string;
}) {
  const text = failureText(reason, { noun, tenantName });
  const retry = canRetry(reason) && onRetry !== undefined;
  let action: ReactNode = otherAction;
  if (reason === "signed_out") {
    action = (
      <ButtonLink variant="primary" icon="arrow-left" href="/">
        Sign in again
      </ButtonLink>
    );
  } else if (retry) {
    action = (
      <Button
        variant="primary"
        icon="refresh"
        busy={retrying}
        busyLabel="Trying again…"
        onClick={onRetry}
      >
        Try again
      </Button>
    );
  }
  return (
    <Notice
      tone="error"
      {...(className ? { className } : {})}
      title={retry && failures > 1 ? `${capitalize(noun)} still didn't load` : text.title}
      actions={action}
    >
      <p>{text.body}</p>
    </Notice>
  );
}
