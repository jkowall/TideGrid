/**
 * Enqueueing transactional email (lane 1, G2.16 demo shim). A message is
 * written in the caller's transaction, with the change that causes it, so it
 * exists only if that change commits; the delivery job sends it after commit.
 * See ../README.md for the contract.
 */
import {
  type AccessPurpose,
  type AccessRevocationReason,
  type EmailMessageState,
  type EmailProviderName,
  isUuid,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { loadEmailBrand } from "./brand.ts";
import { checkContent, type EmailContent, renderEmail, usesAccessLink } from "./render.ts";

/** A management link lasts three days; a guest who needs it later asks for a new one. */
export const DEFAULT_LINK_TTL_SECONDS = 3 * 24 * 3600;
export const MIN_LINK_TTL_SECONDS = 300;
export const MAX_LINK_TTL_SECONDS = 14 * 24 * 3600;

export const dedupeKeyPattern = /^[a-z][a-z0-9_.]*:[A-Za-z0-9_.:-]{1,200}$/;
const templatePattern = /^[a-z][a-z0-9_]{0,63}$/;
export const subjectRefPattern = /^[a-z][a-z0-9_]{0,63}:[0-9a-f-]{36}$/;
const linkPathPattern = /^\/[a-z0-9/_-]{0,100}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const namePattern = /^[^\u0000-\u001f\u007f-\u009f]{1,120}$/;

export interface AccessLinkSpec {
  /** booking_manage: the booking's management page. waiver_sign: a participant's waiver (G2.15). */
  purpose: AccessPurpose;
  /** The guest site's page that redeems it, such as "/manage" or "/waiver". */
  path: string;
  /** How long the link lasts once issued; 300 seconds to 14 days, three days by default. */
  ttlSeconds?: number;
}

export interface EnqueueMessageInput {
  /** Names the logical message, once per tenant for ever: "<topic>:<ids>". */
  dedupeKey: string;
  template: string;
  templateVersion: number;
  to: { email: string; name?: string | null };
  bookingId?: string | null;
  /** Needs bookingId; a waiver link needs it. */
  participantId?: string | null;
  /** What else the message is about, "<type>:<uuid>", such as "waiver_request:<id>". */
  subjectRef?: string | null;
  content: EmailContent;
  /** Issue this link when the message is sent; the content's action must be "access_link". */
  accessLink?: AccessLinkSpec | null;
  /** Send no earlier than this, such as a reminder; default now. */
  notBefore?: Date | null;
}

export type EnqueueMessageResult =
  | { kind: "enqueued"; messageId: string }
  /** A message with this key already exists; nothing new was written. */
  | { kind: "duplicate"; messageId: string };

function normalizeAddress(value: string, what: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new TypeError(`${what} must be an ASCII address`);
  }
  return email;
}

function randomSlot(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Enqueue one message in the caller's transaction. Idempotent by
 * `dedupeKey`: a key already used answers `duplicate` with the first
 * message's id and writes nothing. The content is rendered now, with the
 * tenant's active brand, and stored with the template and its version.
 * Programmer errors (a malformed key, address, id, or content) throw.
 */
export async function enqueueMessage(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: EnqueueMessageInput,
): Promise<EnqueueMessageResult> {
  if (!dedupeKeyPattern.test(input.dedupeKey)) {
    throw new TypeError("a dedupe key is '<topic>:<ids>', lowercase topic, at most 200 characters");
  }
  if (!templatePattern.test(input.template)) throw new TypeError("a template is lower snake case");
  if (
    !Number.isInteger(input.templateVersion) ||
    input.templateVersion < 1 ||
    input.templateVersion > 1000
  ) {
    throw new RangeError("a template version is a whole number from 1 to 1000");
  }
  const toEmail = normalizeAddress(input.to.email, "a recipient");
  const toName = input.to.name?.trim() || null;
  if (toName !== null && !namePattern.test(toName)) {
    throw new TypeError("a recipient's name must be 1 to 120 characters");
  }
  const bookingId = input.bookingId ?? null;
  const participantId = input.participantId ?? null;
  const subjectRef = input.subjectRef ?? null;
  if (bookingId !== null && !isUuid(bookingId)) throw new TypeError("bookingId must be a UUID");
  if (participantId !== null && (!isUuid(participantId) || bookingId === null)) {
    throw new TypeError("participantId must be a UUID, with its bookingId");
  }
  if (subjectRef !== null && !subjectRefPattern.test(subjectRef)) {
    throw new TypeError("subjectRef is '<type>:<uuid>'");
  }
  checkContent(input.content);
  const link = input.accessLink ?? null;
  if (usesAccessLink(input.content) !== (link !== null)) {
    throw new TypeError("an access link and an access-link action come together");
  }
  let ttl: number | null = null;
  if (link) {
    if (link.purpose !== "booking_manage" && link.purpose !== "waiver_sign") {
      throw new TypeError("unknown access purpose");
    }
    if (!linkPathPattern.test(link.path)) throw new TypeError("a link path is like /manage");
    if (bookingId === null) throw new TypeError("an access link needs its bookingId");
    if (link.purpose === "waiver_sign" && participantId === null) {
      throw new TypeError("a waiver link needs its participantId");
    }
    ttl = link.ttlSeconds ?? DEFAULT_LINK_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < MIN_LINK_TTL_SECONDS || ttl > MAX_LINK_TTL_SECONDS) {
      throw new RangeError("a link lasts 300 seconds to 14 days");
    }
  }
  if (input.notBefore != null && Number.isNaN(input.notBefore.getTime())) {
    throw new TypeError("notBefore must be a valid instant");
  }

  const existing = await findByKey(trx, ctx.tenantId, input.dedupeKey);
  if (existing) return { kind: "duplicate", messageId: existing };

  const brand = await loadEmailBrand(trx, ctx.tenantId);
  const slot = link ? randomSlot() : null;
  const rendered = renderEmail(brand, input.content, { slot });
  const replyTo = brand.contactEmail ? brand.contactEmail.toLowerCase() : null;
  const { rows } = await sql<{ id: string }>`
    insert into email_messages (tenant_id, dedupe_key, template, template_version, booking_id,
      participant_id, subject_ref, to_email, to_name, from_name, reply_to, subject, html_body,
      text_body, link_purpose, link_path, link_ttl_seconds, link_slot, next_attempt_at)
    values (${ctx.tenantId}, ${input.dedupeKey}, ${input.template}, ${input.templateVersion},
            ${bookingId}, ${participantId}, ${subjectRef}, ${toEmail}, ${toName}, ${brand.name},
            ${replyTo}, ${rendered.subject}, ${rendered.html}, ${rendered.text},
            ${link?.purpose ?? null}, ${link?.path ?? null}, ${ttl}, ${slot},
            ${input.notBefore ?? null})
    on conflict (tenant_id, dedupe_key) do nothing
    returning id`.execute(trx);
  const id = rows[0]?.id;
  if (id) return { kind: "enqueued", messageId: id };
  // A concurrent transaction wrote the key first and committed.
  const raced = await findByKey(trx, ctx.tenantId, input.dedupeKey);
  if (!raced) throw new Error("a message key conflicted but is not visible");
  return { kind: "duplicate", messageId: raced };
}

async function findByKey(
  trx: TenantTransaction,
  tenantId: string,
  dedupeKey: string,
): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    select id from email_messages where tenant_id = ${tenantId} and dedupe_key = ${dedupeKey}`.execute(
    trx,
  );
  return rows[0]?.id ?? null;
}

export type CancelMessageResult =
  /**
   * Canceled, and the links it carried no longer work. `inFlight`: an attempt
   * was under way, so its email may still arrive, with a link that opens
   * nothing; the attempt records nothing and is never retried.
   */
  | { kind: "canceled"; inFlight: boolean; revokedLinks: number }
  /** Already sent, failed, or canceled: nothing changed. */
  | { kind: "not_cancelable"; state: EmailMessageState }
  | { kind: "not_found" };

export interface CancelMessageOptions {
  /** Why the links the message carried stop working; `withdrawn` when omitted. */
  linkReason?: AccessRevocationReason;
  /**
   * False keeps the links the message carried working, for a message that is
   * no longer worth sending but whose links still serve the guest (a
   * confirmation overtaken by the booking's cancellation). True by default.
   */
  revokeLinks?: boolean;
  /** Recorded on the message as why it was canceled, such as `recipient_changed`. */
  code?: string;
}

const codePattern = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Cancel a message that has not gone out: queued, or claimed and being sent.
 * Revokes, in the same transaction, the unused links the message carried, so
 * once the caller commits no email of this message opens anything and the
 * delivery job never claims it again. Waits for a delivery claim in progress
 * (a short transaction that waits on nothing a caller holds), so the link that
 * claim issued is revoked too. A message already sent, failed, or canceled
 * stays as it is.
 */
export async function cancelMessage(
  trx: TenantTransaction,
  ctx: TenantContext,
  messageId: string,
  options: CancelMessageOptions = {},
): Promise<CancelMessageResult> {
  const tenantId = ctx.tenantId;
  if (!isUuid(messageId)) return { kind: "not_found" };
  if (options.code !== undefined && !codePattern.test(options.code)) {
    throw new TypeError("a cancellation code is lowercase letters, digits, and underscores");
  }
  const { rows } = await sql<{ state: EmailMessageState }>`
    select state from email_messages
     where tenant_id = ${tenantId} and id = ${messageId}
       for update`.execute(trx);
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  if (row.state !== "queued" && row.state !== "sending") {
    return { kind: "not_cancelable", state: row.state };
  }
  await sql`update email_messages set state = 'canceled', last_error_code = ${options.code ?? null}
             where tenant_id = ${tenantId} and id = ${messageId}
               and state in ('queued', 'sending')`.execute(trx);
  const revokedLinks =
    options.revokeLinks === false
      ? 0
      : await revokeMessageLinks(trx, tenantId, messageId, options.linkReason ?? "withdrawn");
  return { kind: "canceled", inFlight: row.state === "sending", revokedLinks };
}

/** Revoke the unused, live links one message carried. */
export async function revokeMessageLinks(
  trx: TenantTransaction,
  tenantId: string,
  messageId: string,
  reason: AccessRevocationReason,
): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    update guest_access_links set revoked_at = now(), revoked_reason = ${reason}
     where tenant_id = ${tenantId} and message_id = ${messageId}
       and consumed_at is null and revoked_at is null
    returning id`.execute(trx);
  return rows.length;
}

export interface MessageStatus {
  id: string;
  template: string;
  templateVersion: number;
  state: EmailMessageState;
  attempts: number;
  /** When the latest attempt was claimed; null before the first. */
  lastAttemptAt: string | null;
  /** When the next attempt is due, while queued. */
  nextAttemptAt: string | null;
  sentAt: string | null;
  failedAt: string | null;
  canceledAt: string | null;
  /**
   * The last attempt's error, such as provider_unavailable or bounced; null
   * once sent. For a canceled message, why, when known (recipient_changed).
   */
  failureCode: string | null;
  provider: EmailProviderName | null;
  createdAt: string;
}

interface StatusRow {
  id: string;
  template: string;
  template_version: number;
  state: EmailMessageState;
  attempts: number;
  last_attempt_at: Date | string | null;
  next_attempt_at: Date | string;
  sent_at: Date | string | null;
  failed_at: Date | string | null;
  canceled_at: Date | string | null;
  last_error_code: string | null;
  provider: EmailProviderName | null;
  created_at: Date | string;
}

const iso = (v: Date | string) => (typeof v === "string" ? new Date(v) : v).toISOString();
const isoOrNull = (v: Date | string | null) => (v === null ? null : iso(v));

function toStatus(row: StatusRow): MessageStatus {
  return {
    id: row.id,
    template: row.template,
    templateVersion: row.template_version,
    state: row.state,
    attempts: row.attempts,
    lastAttemptAt: isoOrNull(row.last_attempt_at),
    nextAttemptAt: row.state === "queued" ? iso(row.next_attempt_at) : null,
    sentAt: isoOrNull(row.sent_at),
    failedAt: isoOrNull(row.failed_at),
    canceledAt: isoOrNull(row.canceled_at),
    failureCode: row.last_error_code,
    provider: row.provider,
    createdAt: iso(row.created_at),
  };
}

const statusColumns = sql`id, template, template_version, state, attempts, last_attempt_at,
  next_attempt_at, sent_at, failed_at, canceled_at, last_error_code, provider, created_at`;

/** One message's delivery status, without its recipient or content; null when not this tenant's. */
export async function getMessageStatus(
  trx: TenantTransaction,
  tenantId: string,
  messageId: string,
): Promise<MessageStatus | null> {
  if (!isUuid(messageId)) return null;
  const { rows } = await sql<StatusRow>`
    select ${statusColumns} from email_messages
     where tenant_id = ${tenantId} and id = ${messageId}`.execute(trx);
  return rows[0] ? toStatus(rows[0]) : null;
}

/** A booking's messages, oldest first, with their delivery status only. */
export async function listBookingMessages(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<MessageStatus[]> {
  if (!isUuid(bookingId)) return [];
  const { rows } = await sql<StatusRow>`
    select ${statusColumns} from email_messages
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
     order by created_at, id`.execute(trx);
  return rows.map(toStatus);
}
