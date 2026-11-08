/**
 * Recorded-shape Email Sending events (W1-EMAIL-EVENTS), for tests only.
 *
 * The shapes follow Cloudflare's event-subscriptions reference
 * (https://developers.cloudflare.com/email-service/reference/event-subscriptions/,
 * read 2026-11-08, schema version 1): `type`, `source` { type, zoneId, domain },
 * `payload` { eventId, messageId, sender, recipient, subject, terminal,
 * delivery, bounce | complaint | failure | rejection }, and `metadata`
 * { accountId, eventSubscriptionId, eventSchemaVersion, eventTimestamp }.
 * Every value here is synthetic: the ids are made up and the addresses use
 * reserved test domains. No live event has been seen yet (O-P7 A9 is owed).
 */
import { randomUUID } from "node:crypto";
import type { CloudflareEmailEventType } from "./events.ts";

/** A made-up account id in the documented form; never a real one. */
export const FIXTURE_ACCOUNT_ID = "00000000000000000000000000c0ffee";
export const FIXTURE_OTHER_ACCOUNT_ID = "00000000000000000000000000bad000";
export const FIXTURE_SENDING_DOMAIN = "mail.tidegrid.test";

export interface FixtureEventOptions {
  messageId: string;
  eventId?: string;
  accountId?: string;
  domain?: string;
  timestamp?: string;
  bounceType?: "hard" | "soft";
  schemaVersion?: number;
}

const hex = (n: number) => randomUUID().replace(/-/g, "").slice(0, n).padEnd(n, "0");

export function cloudflareEmailEvent(
  type: CloudflareEmailEventType,
  options: FixtureEventOptions,
): Record<string, unknown> {
  const domain = options.domain ?? FIXTURE_SENDING_DOMAIN;
  const payload: Record<string, unknown> = {
    eventId: options.eventId ?? randomUUID(),
    messageId: options.messageId,
    sender: `bookings@${domain}`,
    recipient: "guest@example.test",
    subject: "Your booking is confirmed",
    terminal: type !== "deferred",
  };
  switch (type) {
    case "delivered":
      payload.delivery = {
        status: "delivered",
        provider: "external_smtp",
        deliveryTimeMs: 1234,
        smtpStatusCode: "250",
        smtpEnhancedStatusCode: "2.0.0",
        smtpResponse: "250 2.0.0 OK",
      };
      break;
    case "deferred":
      payload.delivery = {
        status: "deferred",
        provider: "external_smtp",
        smtpStatusCode: "451",
        smtpEnhancedStatusCode: "4.2.0",
        smtpResponse: "451 4.2.0 Temporary mailbox error",
      };
      payload.bounce = {
        type: "soft",
        classification: "temporary_failure",
        reason: "451 4.2.0 Temporary mailbox error",
      };
      break;
    case "bounced": {
      const soft = options.bounceType === "soft";
      payload.delivery = {
        status: "bounced",
        provider: "external_smtp",
        smtpStatusCode: soft ? "451" : "550",
        smtpEnhancedStatusCode: soft ? "4.2.0" : "5.1.1",
        smtpResponse: soft
          ? "451 4.2.0 Temporary mailbox error"
          : "550 5.1.1 User unknown guest@example.test",
      };
      payload.bounce = {
        type: soft ? "soft" : "hard",
        classification: soft ? "temporary_failure" : "permanent_failure",
        reason: soft ? "451 4.2.0 Temporary mailbox error" : "550 5.1.1 User unknown",
      };
      break;
    }
    case "failed":
      payload.delivery = { status: "failed" };
      payload.failure = { reason: "delivery_failed" };
      break;
    case "rejected":
      payload.delivery = { status: "rejected" };
      payload.rejection = {
        reason: "suppressed",
        party: "recipient",
        detail: "Recipient is suppressed",
      };
      break;
    case "complained":
      delete payload.subject;
      payload.delivery = { status: "complained" };
      payload.complaint = { type: "abuse" };
      break;
  }
  return {
    type: `cf.email.sending.message.${type}`,
    source: { type: "email.sending", zoneId: hex(32), domain },
    payload,
    metadata: {
      accountId: options.accountId ?? FIXTURE_ACCOUNT_ID,
      eventSubscriptionId: hex(32),
      eventSchemaVersion: options.schemaVersion ?? 1,
      eventTimestamp: options.timestamp ?? "2026-11-08T12:00:00.000Z",
    },
  };
}
