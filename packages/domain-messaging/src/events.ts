/**
 * Email bounce and complaint events (W1-EMAIL-EVENTS, migration 0021).
 *
 * Cloudflare publishes Email Sending events to a queue, never to a webhook,
 * and signs nothing: a queue's messages come only from the account's own
 * event subscriptions and producers. So the checks here are the event's own
 * claims, made before anything is read or written:
 *
 * 1. The event parses to the documented envelope (schema version 1).
 * 2. Its `metadata.accountId` is this deployment's account, and its
 *    `source.domain` is this deployment's sending domain. Anything else is
 *    refused and recorded nowhere.
 * 3. Only `bounced` and `complained` are kept. Delivered, deferred, failed and
 *    rejected events are acknowledged and dropped: the send path already
 *    knows a refusal, and a deferral is not an outcome.
 *
 * The join. The event's `payload.messageId` goes through the adapter's own
 * normalization (`normalizeCloudflareMessageId`), the form the message stored
 * when it was sent, then `app.resolve_email_message` names the one tenant
 * whose sent message carries it. The event is recorded inside that tenant's
 * transaction, under its row-level security. The join form (D1) is a
 * coordinator default: the live comparison of `send()`'s id with an event's
 * `payload.messageId` (O-P7 A9) is still owed.
 *
 * Once. The first bounce or complaint for a message is applied; a later one is
 * recorded as not applied; the same event id again changes nothing. An id
 * that joins no sent message is recorded once in a platform table, joined to
 * nothing.
 *
 * Nothing personal is kept or logged: no recipient, sender, subject, or SMTP
 * response text. Only ids, the event's type and time, the bounce kind, and a
 * short code (the enhanced SMTP status, or the complaint's type).
 */
import { type Database, inTenantTransaction } from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import { normalizeCloudflareMessageId } from "./cloudflare.ts";

/** Every Email Sending event type Cloudflare documents (event subscriptions, schema 1). */
export const CLOUDFLARE_EMAIL_EVENT_TYPES = [
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
] as const;
export type CloudflareEmailEventType = (typeof CLOUDFLARE_EMAIL_EVENT_TYPES)[number];

const typePrefix = "cf.email.sending.message.";
const eventIdPattern = /^[A-Za-z0-9_.:-]{8,128}$/;
const accountIdPattern = /^[0-9a-f]{32}$/;
const domainPattern =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const detailPattern = /^[A-Za-z0-9_.-]{1,64}$/;
const standInPrefix = "cf_no_id.";
const earliestEvent = Date.UTC(2020, 0, 1);
const latestEvent = Date.UTC(2100, 0, 1);
/** A raw provider id is at most this long before normalization; longer is not an id. */
const maxRawMessageId = 998;

/** One event, as far as TideGrid reads it. */
export interface CloudflareEmailEvent {
  type: CloudflareEmailEventType;
  eventId: string;
  accountId: string;
  domain: string;
  /** The provider's id as the event gives it, before normalization. */
  messageId: string;
  occurredAt: Date;
  /** False only when the event says delivery is still being retried. */
  terminal: boolean;
  bounceType: "hard" | "soft" | null;
  /** The enhanced SMTP status for a bounce, or the complaint's type. */
  detailCode: string | null;
}

export type ParseResult =
  | { kind: "parsed"; event: CloudflareEmailEvent }
  | { kind: "invalid"; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads one queue message body. Never throws; never keeps addresses or text. */
export function parseCloudflareEmailEvent(body: unknown): ParseResult {
  if (!isRecord(body)) return { kind: "invalid", reason: "not_an_object" };
  const { type, source, payload, metadata } = body;
  if (typeof type !== "string" || !type.startsWith(typePrefix)) {
    return { kind: "invalid", reason: "type_unknown" };
  }
  const short = type.slice(typePrefix.length);
  if (!(CLOUDFLARE_EMAIL_EVENT_TYPES as readonly string[]).includes(short)) {
    return { kind: "invalid", reason: "type_unknown" };
  }
  if (!isRecord(source) || source.type !== "email.sending" || typeof source.domain !== "string") {
    return { kind: "invalid", reason: "source_invalid" };
  }
  if (!isRecord(metadata) || metadata.eventSchemaVersion !== 1) {
    return { kind: "invalid", reason: "schema_version" };
  }
  const { accountId, eventTimestamp } = metadata;
  if (typeof accountId !== "string" || typeof eventTimestamp !== "string") {
    return { kind: "invalid", reason: "metadata_invalid" };
  }
  const occurredAt = new Date(eventTimestamp);
  const at = occurredAt.getTime();
  // A time the database can hold and a real event could carry; anything else
  // would fail the insert on every retry.
  if (Number.isNaN(at) || at < earliestEvent || at > latestEvent) {
    return { kind: "invalid", reason: "timestamp_invalid" };
  }
  if (!isRecord(payload)) return { kind: "invalid", reason: "payload_invalid" };
  const { eventId, messageId } = payload;
  if (typeof eventId !== "string" || !eventIdPattern.test(eventId)) {
    return { kind: "invalid", reason: "event_id_invalid" };
  }
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    messageId.length > maxRawMessageId
  ) {
    return { kind: "invalid", reason: "message_id_invalid" };
  }
  // The adapter's stand-in for an acceptance with no id is TideGrid's own and
  // predictable from the message id; Cloudflare never sends it, so an event
  // naming it is refused rather than joined.
  if (messageId.startsWith(standInPrefix)) {
    return { kind: "invalid", reason: "message_id_stand_in" };
  }
  let bounceType: CloudflareEmailEvent["bounceType"] = null;
  let detailCode: string | null = null;
  const terminal = payload.terminal !== false;
  if (short === "bounced") {
    const bounce = isRecord(payload.bounce) ? payload.bounce : null;
    if (bounce?.type === "hard" || bounce?.type === "soft") bounceType = bounce.type;
    const delivery = isRecord(payload.delivery) ? payload.delivery : null;
    const code = delivery?.smtpEnhancedStatusCode;
    if (typeof code === "string" && detailPattern.test(code)) detailCode = code;
  } else if (short === "complained") {
    const complaint = isRecord(payload.complaint) ? payload.complaint : null;
    if (typeof complaint?.type === "string" && detailPattern.test(complaint.type)) {
      detailCode = complaint.type;
    }
  }
  return {
    kind: "parsed",
    event: {
      type: short as CloudflareEmailEventType,
      eventId,
      accountId: accountId.toLowerCase(),
      domain: source.domain.toLowerCase().replace(/\.$/, ""),
      messageId,
      occurredAt,
      terminal,
      bounceType,
      detailCode,
    },
  };
}

/** Whose events this deployment accepts. Neither value is ever committed. */
export interface EmailEventsConfig {
  /** The Cloudflare account's id, 32 lowercase hex characters. */
  accountId: string;
  /** The sending domain, the domain of EMAIL_FROM_ADDRESS. */
  sendingDomain: string;
}

/** Validates the configuration; null when it is missing or malformed. */
export function emailEventsConfig(
  accountId: string | undefined,
  sendingDomain: string | undefined,
): EmailEventsConfig | null {
  const account = accountId?.trim().toLowerCase();
  const domain = sendingDomain?.trim().toLowerCase().replace(/\.$/, "");
  if (!account || !accountIdPattern.test(account)) return null;
  if (!domain || !domainPattern.test(domain)) return null;
  return { accountId: account, sendingDomain: domain };
}

export type IngestOutcome =
  /** The message's first bounce or complaint: staff now see it. */
  | "applied"
  /** A later event for a message that already has one: kept, not applied. */
  | "recorded"
  /** This event id was already recorded: nothing changed. */
  | "duplicate"
  /** No sent message carries the id: recorded once, joined to nothing. */
  | "unmatched"
  /** A delivered, deferred, failed, or rejected event: acknowledged, not kept. */
  | "ignored"
  /** Another account's or another sending domain's event: refused, not kept. */
  | "refused_account"
  | "refused_domain"
  /** Not a readable Email Sending event: refused, not kept. */
  | "invalid";

export interface IngestResult {
  outcome: IngestOutcome;
  /** Why an invalid event was refused, as a code. */
  reason?: string;
  eventType?: CloudflareEmailEventType;
  /** Set when the event joined a message. */
  tenantId?: string;
  messageId?: string;
}

const consumerActor = "email_events";

/**
 * Reads, checks, joins, and records one event. Database errors throw, so the
 * caller retries the queue message; every other outcome is final.
 */
export async function ingestEmailEvent(
  db: Kysely<Database>,
  config: EmailEventsConfig,
  body: unknown,
): Promise<IngestResult> {
  const parsed = parseCloudflareEmailEvent(body);
  if (parsed.kind === "invalid") return { outcome: "invalid", reason: parsed.reason };
  const event = parsed.event;
  const base = { eventType: event.type };
  if (event.accountId !== config.accountId) return { ...base, outcome: "refused_account" };
  if (event.domain !== config.sendingDomain) return { ...base, outcome: "refused_domain" };
  // A bounce that is not final (the provider still retries) is not an
  // outcome: applying it would label the message for good.
  if ((event.type !== "bounced" && event.type !== "complained") || !event.terminal) {
    return { ...base, outcome: "ignored" };
  }
  const eventType = event.type;
  const { id: providerMessageId } = await normalizeCloudflareMessageId(event.messageId);

  const { rows } = await sql<{ tenant_id: string; message_id: string }>`
    select tenant_id, message_id from app.resolve_email_message('cloudflare', ${providerMessageId})
  `.execute(db);
  const target = rows[0];
  if (!target) {
    const { rows: recorded } = await sql<{ inserted: boolean }>`
      select app.record_unmatched_email_event('cloudflare', ${event.eventId}, ${eventType},
        ${providerMessageId}, ${event.occurredAt}) as inserted
    `.execute(db);
    return { ...base, outcome: recorded[0]?.inserted ? "unmatched" : "duplicate" };
  }

  const outcome = await inTenantTransaction(
    db,
    { tenantId: target.tenant_id, actorType: "system", actorId: consumerActor },
    async (trx) => {
      const insert = (applied: boolean) =>
        sql<{ id: string }>`
        insert into email_events (tenant_id, provider, event_id, event_type, provider_message_id,
                                  message_id, bounce_type, detail_code, occurred_at, applied)
        values (${target.tenant_id}, 'cloudflare', ${event.eventId}, ${eventType},
                ${providerMessageId}, ${target.message_id}, ${event.bounceType},
                ${event.detailCode}, ${event.occurredAt}, ${applied})
        on conflict do nothing
        returning id`.execute(trx);
      // The first for its message is applied; the partial unique key refuses
      // a second applied row, so a later event lands as not applied, and the
      // same event id lands as neither.
      if ((await insert(true)).rows.length > 0) return "applied" as const;
      if ((await insert(false)).rows.length > 0) return "recorded" as const;
      return "duplicate" as const;
    },
  );
  return { ...base, outcome, tenantId: target.tenant_id, messageId: target.message_id };
}
