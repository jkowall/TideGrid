/**
 * Booking credit (W3-G2.9). docs/v2/02: a booking credit is USD, belongs to
 * one named customer, is not transferable, and has an immutable issue,
 * redemption, reinstatement, and adjustment ledger. Here the customer is the
 * email a booking was made with, lower case, as checkout stores it: one
 * account per customer per operator.
 *
 * The ledger lives in PostgreSQL (migration 0028): every entry is checked
 * against what it claims, the balance moves only through entries, under the
 * account's row lock, and never goes below zero. Every command carries an
 * idempotency key, so a repeated command finds its first entry instead of
 * moving value twice; a key used for a different command is refused.
 *
 * D2 (a coordinator default pending owner confirmation): credit never
 * expires during the pilot, so no entry carries an expiry and nothing
 * expires it. Redemption at checkout arrives with the goals that take a
 * balance at checkout (G2.8, G2.11); the ledger and its rules are here.
 */
import {
  type CreditEntryKind,
  isUuid,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { sql } from "kysely";
import { iso, record } from "./views.ts";

export interface CreditEntryView {
  id: string;
  kind: CreditEntryKind;
  amount: number;
  balanceAfter: number;
  bookingId: string | null;
  cancellationId: string | null;
  reinstatesEntryId: string | null;
  reason: string | null;
  createdAt: string;
  by: "staff" | "guest" | "system" | "support";
}

export interface CreditAccountView {
  id: string;
  balance: number;
  currency: "USD";
  entries: CreditEntryView[];
}

/** Thrown when an idempotency key was used for another credit command. */
export class CreditKeyReusedError extends Error {
  constructor() {
    super("this idempotency key was used for another credit command");
    this.name = "CreditKeyReusedError";
  }
}

export type CreditCommandResult =
  | { kind: "applied"; entry: CreditEntryView; duplicate: boolean }
  /** The account holds less than the command takes; nothing changed. */
  | { kind: "insufficient"; balance: number }
  | { kind: "not_found" };

interface EntryRow {
  id: string;
  account_id: string;
  kind: CreditEntryKind;
  amount: number;
  balance_after: number;
  booking_id: string | null;
  cancellation_id: string | null;
  reinstates_entry_id: string | null;
  reason: string | null;
  created_at: Date | string;
  actor_type: CreditEntryView["by"];
}

const entryColumns = sql`id, account_id, kind, amount, balance_after, booking_id, cancellation_id,
  reinstates_entry_id, reason, created_at, actor_type`;

function entryView(row: EntryRow): CreditEntryView {
  return {
    id: row.id,
    kind: row.kind,
    amount: row.amount,
    balanceAfter: row.balance_after,
    bookingId: row.booking_id,
    cancellationId: row.cancellation_id,
    reinstatesEntryId: row.reinstates_entry_id,
    reason: row.reason,
    createdAt: iso(row.created_at),
    by: row.actor_type,
  };
}

/** The customer's account with this operator, created at zero when it is new. */
export async function ensureCreditAccount(
  trx: TenantTransaction,
  ctx: TenantContext,
  customerEmail: string,
): Promise<string> {
  await sql`insert into credit_accounts (tenant_id, customer_email)
            values (${ctx.tenantId}, ${customerEmail})
            on conflict (tenant_id, customer_email) do nothing`.execute(trx);
  const { rows } = await sql<{ id: string }>`
    select id from credit_accounts
     where tenant_id = ${ctx.tenantId} and customer_email = ${customerEmail}`.execute(trx);
  const id = rows[0]?.id;
  if (!id) throw new Error("a credit account was not found after it was ensured");
  return id;
}

/** The account of the customer who made this booking, or null when they have none. */
export async function creditAccountForBooking(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<CreditAccountView | null> {
  if (!isUuid(bookingId)) return null;
  const { rows } = await sql<{ id: string }>`
    select a.id from bookings b
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
      join credit_accounts a on a.tenant_id = s.tenant_id and a.customer_email = s.booker_email
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  const id = rows[0]?.id;
  return id ? getCreditAccount(trx, tenantId, id) : null;
}

/** One account with its whole ledger, oldest first. */
export async function getCreditAccount(
  trx: TenantTransaction,
  tenantId: string,
  accountId: string,
): Promise<CreditAccountView | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await sql<{ id: string; balance: number }>`
    select id, balance from credit_accounts
     where tenant_id = ${tenantId} and id = ${accountId}`.execute(trx);
  const account = rows[0];
  if (!account) return null;
  const { rows: entries } = await sql<EntryRow>`
    select ${entryColumns} from credit_entries
     where tenant_id = ${tenantId} and account_id = ${accountId}
     order by seq`.execute(trx);
  return {
    id: account.id,
    balance: account.balance,
    currency: "USD",
    entries: entries.map(entryView),
  };
}

/** The balance a booking's customer holds now; 0 when they have no account. */
export async function creditBalanceForBooking(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<number> {
  const { rows } = await sql<{ balance: number }>`
    select a.balance from bookings b
      join checkout_sessions s on s.tenant_id = b.tenant_id and s.id = b.checkout_session_id
      join credit_accounts a on a.tenant_id = s.tenant_id and a.customer_email = s.booker_email
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0]?.balance ?? 0;
}

interface NewEntry {
  id?: string;
  accountId: string;
  kind: CreditEntryKind;
  amount: number;
  bookingId?: string | null;
  cancellationId?: string | null;
  reinstatesEntryId?: string | null;
  reason?: string | null;
  idempotencyKey: string;
}

/**
 * Insert one entry, once per key. A balance the database refuses comes back
 * as insufficient, with nothing changed (the insert runs under a savepoint).
 * A key already used for the same command returns its first entry; for
 * another command, CreditKeyReusedError.
 */
export async function appendCreditEntry(
  trx: TenantTransaction,
  ctx: TenantContext,
  entry: NewEntry,
): Promise<CreditCommandResult> {
  const prior = await entryByKey(trx, ctx.tenantId, entry.idempotencyKey);
  if (prior) return sameCommand(prior, entry);
  await sql`savepoint credit_entry`.execute(trx);
  let inserted: EntryRow | undefined;
  try {
    const { rows } = await sql<EntryRow>`
      insert into credit_entries (id, tenant_id, account_id, kind, amount, booking_id,
        cancellation_id, reinstates_entry_id, reason, idempotency_key)
      values (${entry.id ?? crypto.randomUUID()}, ${ctx.tenantId}, ${entry.accountId},
        ${entry.kind}, ${entry.amount}, ${entry.bookingId ?? null}, ${entry.cancellationId ?? null},
        ${entry.reinstatesEntryId ?? null}, ${entry.reason ?? null}, ${entry.idempotencyKey})
      returning ${entryColumns}`.execute(trx);
    inserted = rows[0];
    await sql`release savepoint credit_entry`.execute(trx);
  } catch (error) {
    // No ON CONFLICT: the balance trigger runs before any conflict check, so
    // a skipped row would still move the balance. A failed insert instead
    // undoes the trigger's work with it, under the savepoint.
    await sql`rollback to savepoint credit_entry`.execute(trx);
    const e = error as { code?: unknown; constraint_name?: unknown };
    const raced =
      (e.code === "23505" && e.constraint_name === "credit_entries_key") ||
      (e.code === "23514" && e.constraint_name === "credit_entries_balance")
        ? await entryByKey(trx, ctx.tenantId, entry.idempotencyKey)
        : undefined;
    // A concurrent command with the same key committed first.
    if (raced) return sameCommand(raced, entry);
    if (e.code === "23514" && e.constraint_name === "credit_entries_balance") {
      const { rows } = await sql<{ balance: number }>`
        select balance from credit_accounts
         where tenant_id = ${ctx.tenantId} and id = ${entry.accountId}`.execute(trx);
      return { kind: "insufficient", balance: rows[0]?.balance ?? 0 };
    }
    throw error;
  }
  if (!inserted) throw new Error("a credit entry was not written");
  const view = entryView(inserted);
  await record(trx, ctx, {
    action: `credit.${entry.kind}`,
    subjectType: "credit_account",
    subjectId: entry.accountId,
    reason: entry.reason ?? null,
    after: {
      entryId: view.id,
      amount: view.amount,
      balanceAfter: view.balanceAfter,
      bookingId: view.bookingId,
      cancellationId: view.cancellationId,
      reinstatesEntryId: view.reinstatesEntryId,
    },
    topic: `credit.${entry.kind === "issue" ? "issued" : entry.kind === "redeem" ? "redeemed" : entry.kind === "reinstate" ? "reinstated" : "adjusted"}`,
    payload: { accountId: entry.accountId, entryId: view.id },
  });
  return { kind: "applied", entry: view, duplicate: false };
}

async function entryByKey(
  trx: TenantTransaction,
  tenantId: string,
  key: string,
): Promise<EntryRow | undefined> {
  const { rows } = await sql<EntryRow>`
    select ${entryColumns} from credit_entries
     where tenant_id = ${tenantId} and idempotency_key = ${key}`.execute(trx);
  return rows[0];
}

function sameCommand(prior: EntryRow, entry: NewEntry): CreditCommandResult {
  if (
    prior.account_id !== entry.accountId ||
    prior.kind !== entry.kind ||
    prior.amount !== entry.amount ||
    prior.booking_id !== (entry.bookingId ?? null) ||
    prior.cancellation_id !== (entry.cancellationId ?? null) ||
    prior.reinstates_entry_id !== (entry.reinstatesEntryId ?? null) ||
    prior.reason !== (entry.reason ?? null)
  ) {
    throw new CreditKeyReusedError();
  }
  return { kind: "applied", entry: entryView(prior), duplicate: true };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const reasonPattern = /^[^\u0000-\u001f\u007f]{1,500}$/;

/**
 * Staff's correction to a balance, up or down, with a reason. A decrease
 * larger than the balance is refused as insufficient.
 */
export async function adjustCredit(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { accountId: string; amount: number; reason: string; idempotencyKey: string },
): Promise<CreditCommandResult> {
  if (
    !Number.isInteger(input.amount) ||
    input.amount === 0 ||
    Math.abs(input.amount) > 100_000_000
  ) {
    throw new RangeError("an adjustment is a whole, nonzero number of cents");
  }
  if (!reasonPattern.test(input.reason)) throw new RangeError("an adjustment needs a reason");
  if (!(await getCreditAccount(trx, ctx.tenantId, input.accountId))) return { kind: "not_found" };
  return appendCreditEntry(trx, ctx, {
    accountId: input.accountId,
    kind: "adjust",
    amount: input.amount,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  });
}

/** Use credit toward a booking of the same customer. */
export async function redeemCredit(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { accountId: string; bookingId: string; amount: number; idempotencyKey: string },
): Promise<CreditCommandResult> {
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 100_000_000) {
    throw new RangeError("a redemption is a whole, positive number of cents");
  }
  if (!isUuid(input.accountId) || !isUuid(input.bookingId)) return { kind: "not_found" };
  return appendCreditEntry(trx, ctx, {
    accountId: input.accountId,
    kind: "redeem",
    amount: -input.amount,
    bookingId: input.bookingId,
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Return a redemption to the balance because its booking was canceled, once
 * (docs/v2/02: credit used on a later canceled booking is restored as
 * credit, not converted to cash).
 */
export async function reinstateCredit(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: { redeemEntryId: string; idempotencyKey: string },
): Promise<CreditCommandResult> {
  if (!isUuid(input.redeemEntryId)) return { kind: "not_found" };
  const { rows } = await sql<EntryRow>`
    select ${entryColumns} from credit_entries
     where tenant_id = ${ctx.tenantId} and id = ${input.redeemEntryId} and kind = 'redeem'`.execute(
    trx,
  );
  const redeemed = rows[0];
  if (!redeemed) return { kind: "not_found" };
  return appendCreditEntry(trx, ctx, {
    accountId: redeemed.account_id,
    kind: "reinstate",
    amount: -redeemed.amount,
    bookingId: redeemed.booking_id,
    reinstatesEntryId: redeemed.id,
    idempotencyKey: input.idempotencyKey,
  });
}
