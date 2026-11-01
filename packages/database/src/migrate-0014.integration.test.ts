import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadMigrations, migrate } from "./migrate.ts";

/**
 * The staff resend ledger's backfill (0014, G2.16b follow-up D8 A). Neon main
 * may hold staff resends written before 0014: each `booking.resend:` message
 * must get its ledger row, with its generation from the key, its kind from
 * its template, and its creation time, or the limits would forget them. A key
 * that does not parse strictly fails the file, which then leaves the database
 * at 0013.
 *
 * Each case gets its own scratch database, copied from one migrated to 0013
 * with no seed. The rows before 0014 are written by the admin with triggers
 * and foreign keys off (session_replication_role = replica), which is safe
 * only because the scratch databases are dropped. It never migrates the job's
 * own database, and it drops only the databases it created.
 */

const env = inject("integrationDb");

type Sql = ReturnType<typeof postgres>;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const tag = randomUUID().replaceAll("-", "").slice(0, 12);
const template = `fu0014_tpl_${tag}`;
const LATEST = "0014_booking_email_resends.sql";

describe.skipIf(!env)("migration 0014 backfills the staff resend ledger", () => {
  let admin: Sql;
  const made: string[] = [];

  /** A fresh copy of the 0013 database, with the rows `write` puts there. */
  async function scratch(
    name: string,
    write: (tx: postgres.TransactionSql) => Promise<void>,
  ): Promise<string> {
    const database = `fu0014_${name}_${tag}`;
    // Generated names: lowercase letters, digits, and underscore only.
    await admin.unsafe(`create database ${database} template ${template}`);
    made.push(database);
    const url = withDatabase(env?.adminUrl ?? "", database);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await write(tx);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
    return url;
  }

  async function onDatabase<T>(url: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  async function tenantAndBooking(
    tx: postgres.TransactionSql,
    tenantId: string,
    bookingId: string,
  ): Promise<void> {
    await tx`insert into public.tenants (id, slug, display_name)
             values (${tenantId}, ${`fu0014-${tenantId.slice(0, 8)}`}, 'Backfill Fixture')`;
    await tx`insert into public.bookings (id, tenant_id, reference, checkout_session_id, order_id,
                payment_id, hold_id, trip_id, party_size, reacquired)
             values (${bookingId}, ${tenantId}, 'BKF14AAA', ${randomUUID()}, ${randomUUID()},
                     ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 1, false)`;
  }

  /** One message as the email trigger would leave it, in the state named. */
  async function message(
    tx: postgres.TransactionSql,
    m: {
      tenantId: string;
      bookingId: string | null;
      key: string;
      template?: string;
      minutesAgo?: number;
      state?: "queued" | "canceled" | "attempted_canceled" | "sent";
    },
  ): Promise<string> {
    const state = m.state ?? "queued";
    const attempted = state === "attempted_canceled" || state === "sent";
    const [row] = await tx<{ id: string }[]>`
      insert into public.email_messages (tenant_id, dedupe_key, template, template_version,
          booking_id, to_email, from_name, subject, html_body, text_body, state, attempts,
          last_attempt_at, provider, provider_message_id, last_error_code, created_at,
          sent_at, canceled_at)
      values (${m.tenantId}, ${m.key}, ${m.template ?? "booking_confirmation"}, 1, ${m.bookingId},
              'synthetic.backfill@example.test', 'Backfill Fixture', 'Backfill', '<p>Backfill.</p>',
              'Backfill.', ${state === "sent" ? "sent" : state === "queued" ? "queued" : "canceled"},
              ${attempted ? 1 : 0},
              ${attempted ? new Date() : null}, ${attempted ? "fake" : null},
              ${state === "sent" ? `backfill-${randomUUID()}` : null},
              ${state === "queued" || state === "sent" ? null : "resent"},
              now() - make_interval(mins => ${m.minutesAgo ?? 1}),
              ${state === "sent" ? new Date() : null},
              ${state === "canceled" || state === "attempted_canceled" ? new Date() : null})
      returning id`;
    if (!row) throw new Error("setup: no message");
    return row.id;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${template}`);
    made.push(template);
    const files = (await loadMigrations()).filter((f) => f.name < "0014");
    expect(files.at(-1)?.name).toBe("0013_sweep_fairness.sql");
    await migrate(withDatabase(env.adminUrl, template), files);
  }, 120_000);

  afterAll(async () => {
    if (!env) return;
    try {
      for (const database of made.reverse()) {
        await admin.unsafe(`drop database if exists ${database} with (force)`);
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it("writes one ledger row per resend message, with its generation, kind, and time", async () => {
    const tenantId = randomUUID();
    const bookingId = randomUUID();
    const ids: Record<string, string> = {};
    const url = await scratch("ok", async (tx) => {
      await tenantAndBooking(tx, tenantId, bookingId);
      const key = (g: number) => `booking.resend:${bookingId}:${g}`;
      ids.queued = await message(tx, { tenantId, bookingId, key: key(1), minutesAgo: 50 });
      ids.canceled = await message(tx, {
        tenantId,
        bookingId,
        key: key(2),
        minutesAgo: 40,
        state: "canceled",
      });
      ids.attempted = await message(tx, {
        tenantId,
        bookingId,
        key: key(3),
        minutesAgo: 30,
        state: "attempted_canceled",
      });
      ids.sent = await message(tx, {
        tenantId,
        bookingId,
        key: key(10),
        template: "booking_canceled",
        minutesAgo: 20,
        state: "sent",
      });
      // Not a staff resend: never in the ledger.
      await message(tx, { tenantId, bookingId, key: `booking.confirmed:${bookingId}` });
    });

    expect((await migrate(url)).applied).toEqual([LATEST]);

    await onDatabase(url, async (sql) => {
      const rows = await sql<
        {
          message_id: string;
          booking_id: string;
          generation: number;
          kind: string;
          same_time: boolean;
          actor_type: string;
          actor_id: string | null;
          api_request_id: string | null;
        }[]
      >`
        select r.message_id, r.booking_id, r.generation, r.kind,
               r.created_at = m.created_at as same_time, r.actor_type, r.actor_id, r.api_request_id
          from public.booking_email_resends r
          join public.email_messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
         where r.tenant_id = ${tenantId}
         order by r.generation`;
      const system = { actor_type: "system", actor_id: null, api_request_id: null };
      expect(rows.map((r) => ({ ...r }))).toEqual([
        {
          message_id: ids.queued,
          booking_id: bookingId,
          generation: 1,
          kind: "confirmation",
          same_time: true,
          ...system,
        },
        {
          message_id: ids.canceled,
          booking_id: bookingId,
          generation: 2,
          kind: "confirmation",
          same_time: true,
          ...system,
        },
        {
          message_id: ids.attempted,
          booking_id: bookingId,
          generation: 3,
          kind: "confirmation",
          same_time: true,
          ...system,
        },
        {
          message_id: ids.sent,
          booking_id: bookingId,
          generation: 10,
          kind: "cancellation",
          same_time: true,
          ...system,
        },
      ]);
      const [facts] = await sql<{ deliverable: number; newest: boolean; operator: number }[]>`
        select f.deliverable,
               f.newest_at = (select created_at from public.email_messages where id = ${ids.sent ?? ""}) as newest,
               f.operator_resends as operator
          from app.booking_resend_facts(${tenantId}, ${bookingId}, now()) f`;
      expect(facts).toEqual({ deliverable: 3, newest: true, operator: 4 });
    });
  });

  it("fails on a key it cannot parse strictly, and the database stays at 0013", async () => {
    const cases: [string, (tenantId: string, bookingId: string) => string, boolean][] = [
      ["bad", () => "booking.resend:bad", false],
      ["lead_zero", (_, b) => `booking.resend:${b}:01`, true],
      ["other_booking", () => `booking.resend:${randomUUID()}:1`, true],
    ];
    for (const [name, key, withBooking] of cases) {
      const tenantId = randomUUID();
      const bookingId = randomUUID();
      const url = await scratch(name, async (tx) => {
        await tenantAndBooking(tx, tenantId, bookingId);
        await message(tx, {
          tenantId,
          bookingId: withBooking ? bookingId : null,
          key: key(tenantId, bookingId),
        });
      });
      await expect(migrate(url), name).rejects.toThrow(`Migration ${LATEST} failed`);
      const state = await onDatabase(
        url,
        (sql) => sql<{ latest: string; ledger: string | null }[]>`
          select (select max(name) from schema_migrations) as latest,
                 to_regclass('public.booking_email_resends')::text as ledger`,
      );
      expect({ name, ...state[0] }).toEqual({
        name,
        latest: "0013_sweep_fairness.sql",
        ledger: null,
      });
    }
  });
});
