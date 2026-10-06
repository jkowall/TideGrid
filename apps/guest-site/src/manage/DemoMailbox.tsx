import { ButtonLink } from "@tidegrid/design-system/components";
import { apiBase } from "../bootstrap.ts";

/**
 * Whether this build links to the demo mailbox, the fake email provider's
 * viewer on a local API (lane 1, the G2.16 shim). Off unless the build sets
 * VITE_DEMO_MAILBOX=1; the API serves the mailbox only when EMAIL_PROVIDER is
 * fake and ENVIRONMENT is local.
 */
export const demoMailbox = import.meta.env.VITE_DEMO_MAILBOX === "1";

/** "Open the demo mailbox", for this site's operator, in a new tab. */
export function DemoMailboxLink() {
  if (!demoMailbox) return null;
  const href = `${apiBase}/v1/fake-email/mailbox/${encodeURIComponent(window.location.hostname)}`;
  return (
    <ButtonLink variant="ghost" icon="mail" href={href} target="_blank" rel="noopener noreferrer">
      Open the demo mailbox
      <span className="tg-visually-hidden"> (opens in a new tab)</span>
    </ButtonLink>
  );
}
