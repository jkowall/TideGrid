/**
 * The fake email provider (G2.16 demo shim, owner decision of 2026-10-05): a
 * stand-in for Cloudflare Email Service behind the neutral adapter. It files
 * every send it answers in its own append-only, tenant-owned table and never
 * touches TideGrid's message table. Nothing leaves the database; no real
 * email is delivered. It exists only when EMAIL_PROVIDER=fake and refuses to
 * run in production.
 *
 * - Idempotent by key: the first accepted delivery for a key is the only one,
 *   and a repeat answers with it, so a retry after an unknown outcome never
 *   sends twice.
 * - Scripted failures, for the demo's retry evidence: a recipient whose local
 *   part ends in `+fail-once` is unavailable on the first attempt of each
 *   message and accepted after; one ending in `+bounce` is refused as
 *   `bounced`. The refusals are recorded too.
 * - The mailbox: reads of what it accepted, for the local mailbox viewer.
 */
import {
  type Database,
  inTenantTransaction,
  isUuid,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import {
  type EmailProvider,
  EmailProviderRejectedError,
  EmailProviderUnavailableError,
  type OutgoingEmail,
} from "./adapter.ts";

export const fakeEmailIdPattern = /^fmsg_[A-Za-z0-9]{24}$/;

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(): string {
  let out = "";
  while (out.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 is the largest multiple of 62 below 256, so every letter is equally likely.
      if (b < 248 && out.length < 24) out += alphabet[b % 62];
    }
  }
  return out;
}

export interface FakeEmailOptions {
  /** The fake's storage, or a function that opens it on first use. */
  db: Kysely<Database> | (() => Kysely<Database>);
  /** The deployment's ENVIRONMENT; "production" is refused. */
  environment: string;
}

export interface FakeMailboxEntry {
  id: string;
  to: string;
  toName: string | null;
  fromName: string;
  fromAddress: string;
  subject: string;
  createdAt: string;
}

export interface FakeMailboxMessage extends FakeMailboxEntry {
  replyTo: string | null;
  html: string;
  text: string;
}

type Outcome =
  | { kind: "accepted"; id: string }
  | { kind: "unavailable" }
  | { kind: "rejected"; code: string };

const iso = (v: Date | string) => (typeof v === "string" ? new Date(v) : v).toISOString();

export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake" as const;
  /** A repeat with the same key answers with the first accepted delivery. */
  readonly deduplicates = true;
  readonly #db: () => Kysely<Database>;

  constructor(options: FakeEmailOptions) {
    if (options.environment === "production") {
      throw new Error("the fake email provider is refused in production");
    }
    const source = options.db;
    this.#db = typeof source === "function" ? source : () => source;
  }

  #context(tenantId: string): TenantContext {
    return { tenantId, actorType: "system", actorId: "fake-email", requestId: null };
  }

  async send(email: OutgoingEmail): Promise<{ providerMessageId: string }> {
    if (!isUuid(email.tenantId)) throw new TypeError("the fake files mail by tenant id");
    const key = email.idempotencyKey;
    if (typeof key !== "string" || key.length < 1 || key.length > 255) {
      throw new TypeError("an idempotency key is 1 to 255 characters");
    }
    const ctx = this.#context(email.tenantId);
    const outcome = await inTenantTransaction(this.#db(), ctx, async (trx) => {
      const first = await acceptedFor(trx, email.tenantId, key);
      if (first) return { kind: "accepted", id: first } as const;
      const local = email.to.email.split("@")[0] ?? "";
      if (local.endsWith("+bounce")) {
        await file(trx, email, "rejected");
        return { kind: "rejected", code: "bounced" } as const;
      }
      if (local.endsWith("+fail-once")) {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from fake_email_deliveries
           where tenant_id = ${email.tenantId} and idempotency_key = ${key}
             and result = 'unavailable'`.execute(trx);
        if ((rows[0]?.n ?? 0) === 0) {
          await file(trx, email, "unavailable");
          return { kind: "unavailable" } as const;
        }
      }
      const id = await file(trx, email, "accepted");
      if (id) return { kind: "accepted", id } as const;
      // A concurrent send of the same key was accepted first.
      const raced = await acceptedFor(trx, email.tenantId, key);
      if (!raced) throw new Error("an accepted delivery conflicted but is not visible");
      return { kind: "accepted", id: raced } as const;
    });
    return settle(outcome);
  }

  /** What it accepted for one tenant, newest first. */
  async listMailbox(tenantId: string, limit = 50): Promise<FakeMailboxEntry[]> {
    if (!isUuid(tenantId)) return [];
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    return inTenantTransaction(this.#db(), this.#context(tenantId), async (trx) => {
      const { rows } = await sql<{
        id: string;
        to_address: string;
        to_name: string | null;
        from_name: string;
        from_address: string;
        subject: string;
        created_at: Date | string;
      }>`
        select id, to_address, to_name, from_name, from_address, subject, created_at
          from fake_email_deliveries
         where tenant_id = ${tenantId} and result = 'accepted'
         order by created_at desc, id desc
         limit ${bounded}`.execute(trx);
      return rows.map((r) => ({
        id: r.id,
        to: r.to_address,
        toName: r.to_name,
        fromName: r.from_name,
        fromAddress: r.from_address,
        subject: r.subject,
        createdAt: iso(r.created_at),
      }));
    });
  }

  /** One accepted message with its bodies, or null. */
  async getMailboxMessage(tenantId: string, id: string): Promise<FakeMailboxMessage | null> {
    if (!isUuid(tenantId) || !fakeEmailIdPattern.test(id)) return null;
    return inTenantTransaction(this.#db(), this.#context(tenantId), async (trx) => {
      const { rows } = await sql<{
        id: string;
        to_address: string;
        to_name: string | null;
        from_name: string;
        from_address: string;
        reply_to: string | null;
        subject: string;
        html_body: string;
        text_body: string;
        created_at: Date | string;
      }>`
        select id, to_address, to_name, from_name, from_address, reply_to, subject, html_body,
               text_body, created_at
          from fake_email_deliveries
         where tenant_id = ${tenantId} and id = ${id} and result = 'accepted'`.execute(trx);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        to: r.to_address,
        toName: r.to_name,
        fromName: r.from_name,
        fromAddress: r.from_address,
        replyTo: r.reply_to,
        subject: r.subject,
        html: r.html_body,
        text: r.text_body,
        createdAt: iso(r.created_at),
      };
    });
  }
}

function settle(outcome: Outcome): { providerMessageId: string } {
  switch (outcome.kind) {
    case "accepted":
      return { providerMessageId: outcome.id };
    case "unavailable":
      throw new EmailProviderUnavailableError(
        "provider_unavailable",
        "the fake provider is unavailable for this attempt (+fail-once)",
      );
    case "rejected":
      throw new EmailProviderRejectedError(outcome.code);
  }
}

async function acceptedFor(
  trx: TenantTransaction,
  tenantId: string,
  key: string,
): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    select id from fake_email_deliveries
     where tenant_id = ${tenantId} and idempotency_key = ${key} and result = 'accepted'`.execute(
    trx,
  );
  return rows[0]?.id ?? null;
}

/** File one answer. For an acceptance, null when another send of the key won. */
async function file(
  trx: TenantTransaction,
  email: OutgoingEmail,
  result: "accepted" | "unavailable" | "rejected",
): Promise<string | null> {
  const id = `fmsg_${randomSuffix()}`;
  const conflict =
    result === "accepted"
      ? sql`on conflict (tenant_id, idempotency_key) where result = 'accepted' do nothing`
      : sql``;
  const { rows } = await sql<{ id: string }>`
    insert into fake_email_deliveries (id, tenant_id, idempotency_key, result, from_address,
      from_name, reply_to, to_address, to_name, subject, html_body, text_body)
    values (${id}, ${email.tenantId}, ${email.idempotencyKey}, ${result}, ${email.from.email},
            ${email.from.name}, ${email.replyTo}, ${email.to.email}, ${email.to.name},
            ${email.subject}, ${email.html}, ${email.text})
    ${conflict}
    returning id`.execute(trx);
  return rows[0]?.id ?? null;
}

export function createFakeEmailProvider(options: FakeEmailOptions): FakeEmailProvider {
  return new FakeEmailProvider(options);
}
