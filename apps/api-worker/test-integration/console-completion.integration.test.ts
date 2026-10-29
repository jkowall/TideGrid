/**
 * G2.12c acceptance and adversarial tests for console completion, through the
 * whole API as tidegrid_app: booking search, a day's control totals, the
 * day's CSV export, and internal booking notes.
 *
 * Every booking here is made the only way the system makes one: a real public
 * checkout, the fake provider's pay control, and its signed webhook. The suite
 * checks each role's view of each route (finance never sees or matches a
 * booker), two tenants on every route (another tenant's id answers exactly as
 * an unknown one does), totals proved against the order, order line, and
 * refund tables, and notes that are append-only, authored by the transaction,
 * and audited without their text.
 *
 * One fixture writes refunds against booked payments, which G2.7's rules
 * refuse because a booking is never refunded until cancellation exists (lane
 * 1 of wave 2 adds it). The refund rule is off only inside the admin
 * transaction that writes them, and the setup checks it is on again after.
 */
import { randomUUID } from "node:crypto";
import {
  BookingDayTotalsResponse,
  BookingNoteCreatedResponse,
  BookingNotesResponse,
  BookingSearchResponse,
  bookingDayExportColumns,
  bookingDayExportGuestColumns,
  type Quote,
} from "@tidegrid/contracts";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  guestContext,
  newSecret,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { systemContext } from "@tidegrid/domain-inventory/testing";
import {
  createPriceListVersion,
  createQuote,
  createTaxRate,
  type PartySelection,
} from "@tidegrid/domain-pricing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & {
  error?: { code: string; message: string; requestId?: string };
};
type Res = { status: number; headers: Headers; json: Json; text: string };
type Tenant = CheckoutFixture & { host: string; owner: string; staff: string; finance: string };
type Booker = { name: string; email: string };

interface Made {
  tripId: string;
  sessionId: string;
  paymentId: string;
  bookingId: string;
  reference: string;
  booker: Booker;
}

const env = inject("integrationDb");
const TEAM = "tidegrid-console-completion.cloudflareaccess.com";
const AUD = "c3".repeat(32);
const CONSOLE = "https://console.test";

/** Every A and B booker. B's first booker shares A's first booker's name and email. */
const people = {
  maya: { name: "Maya Okonkwo", email: "maya.okonkwo@guest.example" },
  luis: { name: "Luis Fernández", email: "luis.f+console@guest.example" },
  priya: { name: "Priya Raman", email: "priya.raman@guest.example" },
  ada: { name: "Ada Okonkwo-Reyes", email: "ada@charters.example" },
  formula: { name: '=HYPERLINK("http://x.example","go")', email: "formula@guest.example" },
  refunded: { name: "Rufus Quillfeather", email: "rufus@guest.example" },
  pending: { name: "Penny Marchetti", email: "penny@guest.example" },
  percent: { name: "Pat 100% Sure", email: "pat_sure@guest.example" },
} as const;
const bMaya = people.maya;
const bOnly = { name: "Bea Elsewhere", email: "bea.elsewhere@guest.example" } as const;

/**
 * Every fragment of personal data in the fixture, in its stored case. Checks
 * compare case-sensitively: booking references are random uppercase letters and
 * digits, and lowercased they can spell a short name such as "maya".
 */
const personal = [...Object.values(people), bOnly].flatMap((p) => [
  p.email,
  ...p.name.split(/[\s,()"=]+/).filter((w) => w.length > 3 && !/^(http|example)/i.test(w)),
]);

const adults = (n: number): PartySelection => ({
  kind: "tickets",
  tickets: [{ code: "adult", quantity: n }],
});
const aboard = (n: number): PartySelection => ({ kind: "charter", guests: n });

function at<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) throw new Error(`fixture has no item ${i}`);
  return value;
}

/** Every JSON key at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

/** A minimal RFC 4180 reader for the export; it checks and drops the byte order mark. */
function parseCsv(withMark: string): string[][] {
  expect(withMark.startsWith("\ufeff")).toBe(true);
  const text = withMark.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  expect(field).toBe("");
  return rows;
}

const cents = (decimal: string | undefined) => {
  expect(decimal).toMatch(/^\d+\.\d{2}$/);
  return Number((decimal ?? "").replace(".", ""));
};

describe.skipIf(!env)("G2.12c console completion through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let verifier: ReturnType<typeof createAccessVerifier>;
  let signingKey: CryptoKey;
  let A: Tenant;
  let B: Tenant;
  const kid = `kid-${randomUUID().slice(0, 8)}`;
  let addressCount = 0;

  interface Fixtures {
    /** A's days: d0 rich, single, pair, and a charter; d1 the formula and percent names; d2 refunds. */
    day: { d0: string; d1: string; d2: string; empty: string };
    rich: Made;
    single: Made;
    pair: Made;
    charter: Made;
    formula: Made;
    percent: Made;
    refunded: Made;
    pending: Made;
    /** B, on its first day, the same date as A's d0: Maya again, and Bea. */
    bMaya: Made;
    bBea: Made;
    /** Finance at A and owner at B. */
    twoHats: string;
    disabledOwner: string;
  }
  let fx: Fixtures;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function token(email: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ type: "app", email })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setSubject(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signingKey);
  }

  async function request(
    method: string,
    path: string,
    opts: {
      origin?: string;
      as?: string;
      body?: unknown;
      headers?: Record<string, string>;
      /** Another app instance, such as one with a lower day report limit. */
      via?: ReturnType<typeof createApp>;
    } = {},
  ): Promise<Res> {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const res = await (opts.via ?? app).request(
      `http://localhost${path}`,
      { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) },
      bindings(),
      executionCtx,
    );
    // Decoded by hand: Response.text() drops a leading byte order mark, and
    // the export's first bytes are what a spreadsheet reads.
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = {};
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  // Paths and calls -------------------------------------------------------------------

  const staffBase = (tenantId: string) => `/v1/staff/tenants/${encodeURIComponent(tenantId)}`;
  const searchPath = (tenantId: string) => `${staffBase(tenantId)}/booking-searches`;
  const totalsPath = (tenantId: string, date: string) =>
    `${staffBase(tenantId)}/booking-day-totals?${new URLSearchParams({ date })}`;
  const exportPath = (tenantId: string, date: string) =>
    `${staffBase(tenantId)}/booking-day-export?${new URLSearchParams({ date })}`;
  const notesPath = (tenantId: string, bookingId: string) =>
    `${staffBase(tenantId)}/bookings/${encodeURIComponent(bookingId)}/notes`;

  const search = (tenantId: string, as: string, body: unknown) =>
    request("POST", searchPath(tenantId), { origin: CONSOLE, as, body });
  const addNote = (tenantId: string, bookingId: string, as: string, body: unknown, key?: string) =>
    request("POST", notesPath(tenantId, bookingId), {
      origin: CONSOLE,
      as,
      body,
      headers: { "idempotency-key": key ?? `note-${randomUUID()}` },
    });

  // Fixtures through the real checkout ----------------------------------------------------

  const guestOrigin = (t: Tenant) => `https://${t.host}`;
  const nextAddress = () => `203.0.113.${(addressCount++ % 250) + 1}`;

  async function quote(
    t: Tenant,
    tripId: string,
    party: PartySelection,
    extra: { addOns?: { code: string; quantity: number }[]; promotionCode?: string } = {},
  ): Promise<Quote> {
    const ctx = guestContext(t.id);
    const created = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createQuote(trx, ctx, {
        tripId,
        party,
        addOns: extra.addOns ?? [],
        promotionCode: extra.promotionCode ?? null,
        now: new Date(),
      }),
    );
    if (created.kind !== "created") throw new Error(`quote: ${JSON.stringify(created)}`);
    return created.quote;
  }

  async function book(t: Tenant, q: Quote, who: Booker): Promise<Made> {
    const res = await request("POST", "/v1/public/checkout-sessions", {
      origin: guestOrigin(t),
      body: {
        quoteId: q.quoteId,
        acceptedPolicyVersion: q.policy.version,
        booker: who,
        checkoutSecret: newSecret(),
      },
      headers: { "idempotency-key": `chk-${randomUUID()}`, "cf-connecting-ip": nextAddress() },
    });
    const session = res.json.checkoutSession as { id: string } | undefined;
    const payment = res.json.payment as { paymentRef: string; clientSecret: string } | null;
    if (res.status !== 201 || !session || !payment) {
      throw new Error(`open: ${res.status} ${res.text}`);
    }
    const paid = await request("POST", `/v1/fake-provider/payments/${payment.paymentRef}/succeed`, {
      origin: guestOrigin(t),
      headers: { authorization: `Bearer ${payment.clientSecret}` },
    });
    const delivery = paid.json.delivery as { outcome?: string | null } | null | undefined;
    if (paid.status !== 200 || delivery?.outcome !== "confirmed") {
      throw new Error(`pay: ${paid.status} ${paid.text}`);
    }
    const [row] = await admin<{ id: string; reference: string; payment_id: string }[]>`
      select id, reference, payment_id from public.bookings where checkout_session_id = ${session.id}`;
    if (!row) throw new Error(`no booking for checkout ${session.id}`);
    return {
      tripId: q.tripId,
      sessionId: session.id,
      paymentId: row.payment_id,
      bookingId: row.id,
      reference: row.reference,
      booker: who,
    };
  }

  async function member(
    tenantId: string,
    email: string,
    role: "owner" | "booking_staff" | "finance",
    status: "active" | "disabled" = "active",
    displayName: string = role,
  ): Promise<string> {
    const [found] = await admin<{ id: string }[]>`
      select id from public.staff_users where email = ${email}`;
    const userId = found?.id ?? randomUUID();
    if (!found) {
      await admin`insert into public.staff_users (id, email, display_name)
        values (${userId}, ${email}, ${role})`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name, status)
      values (${tenantId}, ${userId}, ${role}, ${displayName}, ${status})`;
    return email;
  }

  async function withAccess(f: CheckoutFixture, label: string): Promise<Tenant> {
    const host = `${f.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${f.id}, 'preview', 'active', now())`;
    const mail = (role: string) => `${label}-${role}-${f.id.slice(0, 8)}@example.test`;
    return {
      ...f,
      host,
      owner: await member(f.id, mail("owner"), "owner", "active", "Olive Owner"),
      staff: await member(f.id, mail("staff"), "booking_staff", "active", "Sam Desk"),
      finance: await member(f.id, mail("finance"), "finance", "active", "Fay Books"),
    };
  }

  /**
   * A's shared trips sell adults and children, a per-guest port fee, and two
   * add-ons, and A charges a 5% tax inside its prices beside the fixture's 7%
   * added tax, so the day's orders carry every kind of line.
   */
  async function richTerms(t: Tenant) {
    const ctx = systemContext(t.id, "g212c-fixture");
    await inTenantTransaction(runtime.db, ctx, async (trx) => {
      const levy = await createTaxRate(trx, ctx, {
        name: "Fixture included levy",
        ratePpm: 50_000,
        inclusive: true,
        reason: "fixture",
      });
      if (levy.kind !== "created") throw new Error(`levy: ${JSON.stringify(levy)}`);
      const prices = await createPriceListVersion(trx, ctx, {
        productId: t.products.shared,
        tickets: [
          { code: "adult", name: "Adult", unitAmount: 5000, taxable: true },
          { code: "child", name: "Child 3 to 12", unitAmount: 2500, taxable: true },
        ],
        fees: [
          {
            code: "port",
            name: "Port fee",
            unitAmount: 250,
            basis: "per_participant",
            taxable: false,
          },
        ],
        addOns: [
          {
            code: "snorkel",
            name: "Snorkel set",
            unitAmount: 1200,
            quantityRule: "per_participant",
            maxQuantity: 1,
            taxable: true,
          },
        ],
        reason: "fixture",
      });
      if (prices.kind !== "created") throw new Error(`prices: ${JSON.stringify(prices)}`);
    });
  }

  async function dateOf(tripId: string): Promise<string> {
    const [row] = await admin<{ d: string }[]>`
      select local_date::text as d from public.scheduled_trips where id = ${tripId}`;
    if (!row) throw new Error(`no trip ${tripId}`);
    return row.d;
  }

  /**
   * Refunds against booked payments, which no request can make until booking
   * cancellation exists: one succeeded for the full amount and one still
   * requested. The refund rule is off only inside this admin transaction.
   */
  async function refundBookedPayments(succeeded: Made, requested: Made) {
    await admin.begin(async (tx) => {
      await tx`alter table public.payment_refunds disable trigger payment_refunds_rules`;
      for (const [made, state] of [
        [succeeded, "succeeded"],
        [requested, "requested"],
      ] as const) {
        await tx`
          insert into public.payment_refunds
            (tenant_id, payment_id, amount, reason, idempotency_key, provider_refund_id, state, settled_at)
          select p.tenant_id, p.id, p.amount, 'unfulfilled_payment', ${`fixture-${randomUUID()}`},
                 ${state === "succeeded" ? "frf_fixture_g212c" : null}, ${state},
                 ${state === "succeeded" ? new Date() : null}
            from public.payments p where p.id = ${made.paymentId}`;
      }
      await tx`alter table public.payment_refunds enable trigger payment_refunds_rules`;
    });
    const [trigger] = await admin<{ enabled: string }[]>`
      select tgenabled as enabled from pg_trigger
       where tgname = 'payment_refunds_rules' and tgrelid = 'public.payment_refunds'::regclass`;
    if (trigger?.enabled !== "O") throw new Error("the refund rule trigger is not on");
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    verifier = createAccessVerifier({
      teamDomain: TEAM,
      audience: AUD,
      keys: createLocalJWKSet({ keys: [jwk] }),
    });
    app = createApp({ accessVerifier: verifier });

    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "g212c-a", { days: 6 }),
      createCheckoutFixture(admin, runtime.db, "g212c-b", { days: 3 }),
    ]);
    A = await withAccess(a, "g212c-a");
    B = await withAccess(b, "g212c-b");
    await richTerms(A);
    const twoHats = `g212c-two-hats-${A.id.slice(0, 8)}@example.test`;
    await member(A.id, twoHats, "finance");
    await member(B.id, twoHats, "owner");
    const disabledOwner = await member(
      A.id,
      `g212c-a-disabled-${A.id.slice(0, 8)}@example.test`,
      "owner",
      "disabled",
    );

    const shared = (i: number) => at(A.trips.shared, i);
    // One after another, so each day's order is known.
    const rich = await book(
      A,
      await quote(
        A,
        shared(0),
        {
          kind: "tickets",
          tickets: [
            { code: "adult", quantity: 2 },
            { code: "child", quantity: 1 },
          ],
        },
        { addOns: [{ code: "snorkel", quantity: 3 }], promotionCode: A.promotionCode },
      ),
      people.maya,
    );
    const single = await book(A, await quote(A, shared(0), adults(1)), people.luis);
    const pairBooking = await book(A, await quote(A, shared(0), adults(2)), people.priya);
    const charter = await book(A, await quote(A, at(A.trips.charter, 0), aboard(4)), people.ada);
    const formula = await book(A, await quote(A, shared(1), adults(1)), people.formula);
    const percent = await book(A, await quote(A, shared(1), adults(1)), people.percent);
    const refunded = await book(A, await quote(A, shared(2), adults(2)), people.refunded);
    const pending = await book(A, await quote(A, shared(2), adults(1)), people.pending);
    await refundBookedPayments(refunded, pending);
    const bShared = at(B.trips.shared, 0);
    const bMayaBooking = await book(B, await quote(B, bShared, adults(1)), bMaya);
    const bBea = await book(B, await quote(B, bShared, adults(2)), bOnly);

    fx = {
      day: {
        d0: await dateOf(shared(0)),
        d1: await dateOf(shared(1)),
        d2: await dateOf(shared(2)),
        empty: await dateOf(shared(5)),
      },
      rich,
      single,
      pair: pairBooking,
      charter,
      formula,
      percent,
      refunded,
      pending,
      bMaya: bMayaBooking,
      bBea,
      twoHats,
      disabledOwner,
    };
  }, 300_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  // The ledger, read as the admin role -------------------------------------------------------

  /** A day's totals straight from the order and refund tables. */
  async function ledgerTotals(tenantId: string, date: string) {
    const [row] = await admin<
      {
        bookings: number;
        guests: number;
        gross: number;
        discounts: number;
        fees: number;
        taxes: number;
        total: number;
        included_tax: number;
        refunds: number;
        pending_count: number;
        pending_amount: number;
      }[]
    >`
      select count(*)::int as bookings,
             coalesce(sum(b.party_size), 0)::int as guests,
             coalesce(sum(o.subtotal_amount), 0)::int as gross,
             coalesce(sum(o.discount_amount), 0)::int as discounts,
             coalesce(sum(o.fee_amount), 0)::int as fees,
             coalesce(sum(o.tax_amount), 0)::int as taxes,
             coalesce(sum(o.total_amount), 0)::int as total,
             coalesce(sum(o.included_tax_amount), 0)::int as included_tax,
             coalesce(sum((select coalesce(sum(r.amount), 0) from public.payment_refunds r
                            where r.payment_id = b.payment_id and r.state = 'succeeded')), 0)::int as refunds,
             coalesce(sum((select count(*) from public.payment_refunds r
                            where r.payment_id = b.payment_id and r.state = 'requested')), 0)::int as pending_count,
             coalesce(sum((select coalesce(sum(r.amount), 0) from public.payment_refunds r
                            where r.payment_id = b.payment_id and r.state = 'requested')), 0)::int as pending_amount
        from public.bookings b
        join public.scheduled_trips t on t.id = b.trip_id
        join public.orders o on o.id = b.order_id
       where b.tenant_id = ${tenantId} and t.local_date = ${date}::date`;
    if (!row) throw new Error("no ledger row");
    return {
      bookings: row.bookings,
      guests: row.guests,
      gross: row.gross,
      discounts: row.discounts,
      fees: row.fees,
      taxes: row.taxes,
      total: row.total,
      refunds: row.refunds,
      net: row.total - row.refunds,
      includedTax: row.included_tax,
      pendingRefunds: { count: row.pending_count, amount: row.pending_amount },
    };
  }

  /** The same day's money summed from the order lines themselves, by kind. */
  async function lineTotals(tenantId: string, date: string) {
    const [row] = await admin<
      { gross: number; discounts: number; fees: number; taxes: number; included: number }[]
    >`
      select coalesce(sum(l.amount) filter (where l.kind in ('service', 'add_on')), 0)::int as gross,
             coalesce(-sum(l.amount) filter (where l.kind = 'discount'), 0)::int as discounts,
             coalesce(sum(l.amount) filter (where l.kind = 'fee'), 0)::int as fees,
             coalesce(sum(l.amount) filter (where l.kind = 'tax' and not l.tax_inclusive), 0)::int as taxes,
             coalesce(sum(l.amount) filter (where l.kind = 'tax' and l.tax_inclusive), 0)::int as included
        from public.bookings b
        join public.scheduled_trips t on t.id = b.trip_id
        join public.order_lines l on l.order_id = b.order_id
       where b.tenant_id = ${tenantId} and t.local_date = ${date}::date`;
    if (!row) throw new Error("no line totals");
    return row;
  }

  // Search -----------------------------------------------------------------------------------

  describe("search", () => {
    const refsOf = (r: Res) =>
      (r.json.results as { reference: string }[] | undefined)?.map((x) => x.reference) ?? [];

    it("finds a booking by its reference, read the way a guest quotes it, for every role", async () => {
      const ref = fx.rich.reference;
      const quoted = `${ref.slice(0, 4).toLowerCase()}-${ref.slice(4)}`.replaceAll("0", "o");
      for (const as of [A.owner, A.staff, A.finance]) {
        const res = await search(A.id, as, { q: quoted });
        expect(res.status, res.text).toBe(200);
        expect(BookingSearchResponse.parse(res.json).results.map((r) => r.id)).toEqual([
          fx.rich.bookingId,
        ]);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    });

    it("finds by the start of a reference", async () => {
      const res = await search(A.id, A.owner, { q: fx.pair.reference.slice(0, 5) });
      expect(refsOf(res)).toContain(fx.pair.reference);
    });

    it("finds owners and booking staff a booking by every word of the name, in any order and case", async () => {
      for (const as of [A.owner, A.staff]) {
        const res = await search(A.id, as, { q: "okonkwo MAYA" });
        expect(res.status).toBe(200);
        const body = BookingSearchResponse.parse(res.json);
        expect(body.results.map((r) => r.id)).toEqual([fx.rich.bookingId]);
        expect(body.results[0]?.booker).toEqual(people.maya);
        expect(body.matchedOn).toEqual(["reference", "booker_name", "booker_email"]);
      }
      // A word anywhere in the name: both Okonkwos at A, and never B's Maya.
      const both = await search(A.id, A.owner, { q: "okonkwo" });
      expect(new Set(refsOf(both))).toEqual(new Set([fx.rich.reference, fx.charter.reference]));
    });

    it("finds by part of the email, ignoring case", async () => {
      const res = await search(A.id, A.owner, { q: "F+CONSOLE@guest" });
      expect(refsOf(res)).toEqual([fx.single.reference]);
      expect(BookingSearchResponse.parse(res.json).results[0]?.booker?.name).toBe("Luis Fernández");
    });

    it("treats LIKE's own characters as text", async () => {
      expect(refsOf(await search(A.id, A.owner, { q: "100%" }))).toEqual([fx.percent.reference]);
      expect(refsOf(await search(A.id, A.owner, { q: "pat_sure" }))).toEqual([
        fx.percent.reference,
      ]);
      for (const q of ["%%", "__", "%_%", "\\%"]) {
        const res = await search(A.id, A.owner, { q });
        expect(res.status).toBe(200);
        expect(BookingSearchResponse.parse(res.json).total).toBe(0);
      }
    });

    it("never matches finance's text on a name or an email, and sends finance no booker", async () => {
      for (const q of ["okonkwo", "Maya Okonkwo", "maya.okonkwo@guest", "guest.example", "Raman"]) {
        const res = await search(A.id, A.finance, { q });
        expect(res.status, res.text).toBe(200);
        const body = BookingSearchResponse.parse(res.json);
        expect(body).toEqual({ results: [], total: 0, nextAfter: null, matchedOn: ["reference"] });
      }
      const dated = await search(A.id, A.finance, { from: fx.day.d0, to: fx.day.d2 });
      expect(dated.status).toBe(200);
      expect(keysOf(dated.json).has("booker")).toBe(false);
      for (const fragment of personal) expect(dated.text, fragment).not.toContain(fragment);
      expect(BookingSearchResponse.parse(dated.json).total).toBe(8);
    });

    it("judges finance by its role at this operator, not at another", async () => {
      const atA = await search(A.id, fx.twoHats, { q: "okonkwo" });
      expect(BookingSearchResponse.parse(atA.json).total).toBe(0);
      const atB = await search(B.id, fx.twoHats, { q: "okonkwo" });
      expect(refsOf(atB)).toEqual([fx.bMaya.reference]);
    });

    it("finds by departure dates, inclusive, in departure order, with the count", async () => {
      const res = await search(A.id, A.owner, { from: fx.day.d1, to: fx.day.d2 });
      const body = BookingSearchResponse.parse(res.json);
      expect(body.total).toBe(4);
      expect(body.results.map((r) => r.id)).toEqual([
        fx.formula.bookingId,
        fx.percent.bookingId,
        fx.refunded.bookingId,
        fx.pending.bookingId,
      ]);
      expect(body.matchedOn).toEqual([]);
      const one = await search(A.id, A.owner, { from: fx.day.d1, to: fx.day.d1 });
      expect(BookingSearchResponse.parse(one.json).total).toBe(2);
      const after = await search(A.id, A.owner, { from: fx.day.d2 });
      expect(BookingSearchResponse.parse(after.json).total).toBe(2);
      const before = await search(A.id, A.owner, { to: fx.day.d0 });
      expect(BookingSearchResponse.parse(before.json).total).toBe(4);
      const combined = await search(A.id, A.owner, { q: "marchetti", from: fx.day.d2 });
      expect(refsOf(combined)).toEqual([fx.pending.reference]);
      const outside = await search(A.id, A.owner, { q: "marchetti", to: fx.day.d1 });
      expect(BookingSearchResponse.parse(outside.json).total).toBe(0);
    });

    it("pages without overlap or gaps, and refuses a cursor this search does not find", async () => {
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await search(A.id, A.owner, {
          from: fx.day.d0,
          to: fx.day.d2,
          limit: 3,
          ...(after ? { after } : {}),
        });
        expect(res.status, res.text).toBe(200);
        const body = BookingSearchResponse.parse(res.json);
        expect(body.total).toBe(8);
        seen.push(...body.results.map((r) => r.id));
        if (!body.nextAfter) break;
        after = body.nextAfter;
      }
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);

      const outside = await search(A.id, A.owner, {
        from: fx.day.d1,
        after: fx.rich.bookingId,
      });
      expect(outside.status).toBe(400);
      expect(outside.json.error?.code).toBe("cursor_invalid");
      const otherTenant = await search(A.id, A.owner, {
        from: fx.day.d0,
        after: fx.bMaya.bookingId,
      });
      expect(otherTenant.status).toBe(400);
      expect(otherTenant.json.error?.code).toBe("cursor_invalid");
    });

    it("never finds another operator's bookings, by reference, name, or date", async () => {
      expect(
        BookingSearchResponse.parse((await search(A.id, A.owner, { q: fx.bBea.reference })).json)
          .total,
      ).toBe(0);
      expect(
        BookingSearchResponse.parse((await search(A.id, A.owner, { q: "Bea Elsewhere" })).json)
          .total,
      ).toBe(0);
      const sameName = await search(A.id, A.owner, { q: "maya" });
      expect(refsOf(sameName)).toEqual([fx.rich.reference]);
      const bDay = await search(B.id, B.owner, { from: fx.day.d0, to: fx.day.d2 });
      expect(new Set(refsOf(bDay))).toEqual(new Set([fx.bMaya.reference, fx.bBea.reference]));
    });

    it("answers another tenant, a disabled member, and a stranger as an unknown tenant", async () => {
      for (const [tenantId, as] of [
        [B.id, A.owner],
        [A.id, fx.disabledOwner],
        [randomUUID(), A.owner],
        ["not-a-uuid", A.owner],
      ] as const) {
        const res = await search(tenantId, as, { q: "maya" });
        expect(res.status).toBe(404);
        expect(res.json.error?.code).toBe("tenant_not_found");
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    });

    it("refuses a search without a signed-in console, an origin, or a criterion", async () => {
      const anonymous = await request("POST", searchPath(A.id), {
        origin: CONSOLE,
        body: { q: "maya" },
      });
      expect(anonymous.status).toBe(401);
      const foreign = await request("POST", searchPath(A.id), {
        origin: "https://evil.example",
        as: A.owner,
        body: { q: "maya" },
      });
      expect(foreign.status).toBe(403);
      expect(foreign.json.error?.code).toBe("origin_not_allowed");
      // Refused by a guard before the route, and still never cached (review data F2).
      expect(foreign.headers.get("cache-control")).toBe("no-store");
      for (const body of [
        {},
        { q: "m" },
        { q: "  m  " },
        { q: "line\nbreak" },
        { q: "x".repeat(121) },
        { from: "0000-01-01" },
        { from: "2026-02-30" },
        { q: "maya", limit: 101 },
        { q: "maya", after: "not-a-uuid" },
      ]) {
        const res = await search(A.id, A.owner, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.json.error?.code).toBe("validation_failed");
      }
      const backwards = await search(A.id, A.owner, { from: fx.day.d2, to: fx.day.d0 });
      expect(backwards.status).toBe(400);
      expect(backwards.json.error?.code).toBe("invalid_range");
    });
  });

  // A day's totals and its export -----------------------------------------------------------

  describe("a day's totals", () => {
    it("equal the ledger for every role, from the orders, their lines, and their refunds", async () => {
      for (const date of [fx.day.d0, fx.day.d1, fx.day.d2]) {
        const ledger = await ledgerTotals(A.id, date);
        const lines = await lineTotals(A.id, date);
        expect(lines).toEqual({
          gross: ledger.gross,
          discounts: ledger.discounts,
          fees: ledger.fees,
          taxes: ledger.taxes,
          included: ledger.includedTax,
        });
        for (const as of [A.owner, A.staff, A.finance]) {
          const res = await request("GET", totalsPath(A.id, date), { as });
          expect(res.status, res.text).toBe(200);
          expect(res.headers.get("cache-control")).toBe("no-store");
          const body = BookingDayTotalsResponse.parse(res.json);
          expect(body.date).toBe(date);
          expect(body.totals).toEqual(ledger);
        }
      }
    });

    it("carry every kind of line on the rich day, and refunds on the refund day", async () => {
      const d0 = BookingDayTotalsResponse.parse(
        (await request("GET", totalsPath(A.id, fx.day.d0), { as: A.owner })).json,
      ).totals;
      expect(d0.bookings).toBe(4);
      expect(d0.guests).toBe(10);
      for (const figure of [d0.gross, d0.discounts, d0.fees, d0.taxes, d0.includedTax]) {
        expect(figure).toBeGreaterThan(0);
      }
      expect(d0.total).toBe(d0.gross - d0.discounts + d0.fees + d0.taxes);
      expect(d0.refunds).toBe(0);
      expect(d0.net).toBe(d0.total);

      const d2 = BookingDayTotalsResponse.parse(
        (await request("GET", totalsPath(A.id, fx.day.d2), { as: A.finance })).json,
      ).totals;
      const [refunded] = await admin<{ amount: number }[]>`
        select amount from public.payments where id = ${fx.refunded.paymentId}`;
      const [pending] = await admin<{ amount: number }[]>`
        select amount from public.payments where id = ${fx.pending.paymentId}`;
      expect(d2.refunds).toBe(refunded?.amount);
      expect(d2.pendingRefunds).toEqual({ count: 1, amount: pending?.amount });
      expect(d2.net).toBe(d2.total - d2.refunds);
    });

    it("count only this operator's bookings on a date both operators sell", async () => {
      const bDay = await dateOf(at(B.trips.shared, 0));
      expect(bDay).toBe(fx.day.d0);
      const a = BookingDayTotalsResponse.parse(
        (await request("GET", totalsPath(A.id, fx.day.d0), { as: A.owner })).json,
      ).totals;
      const b = BookingDayTotalsResponse.parse(
        (await request("GET", totalsPath(B.id, fx.day.d0), { as: B.owner })).json,
      ).totals;
      expect(a).toEqual(await ledgerTotals(A.id, fx.day.d0));
      expect(b).toEqual(await ledgerTotals(B.id, fx.day.d0));
      expect(b.bookings).toBe(2);
    });

    it("are zero on a day with nothing booked", async () => {
      const res = await request("GET", totalsPath(A.id, fx.day.empty), { as: A.finance });
      expect(BookingDayTotalsResponse.parse(res.json).totals).toEqual({
        bookings: 0,
        guests: 0,
        gross: 0,
        discounts: 0,
        fees: 0,
        taxes: 0,
        total: 0,
        refunds: 0,
        net: 0,
        includedTax: 0,
        pendingRefunds: { count: 0, amount: 0 },
      });
    });

    it("refuse a date PostgreSQL cannot hold, another tenant, and a stranger", async () => {
      const zero = await request("GET", totalsPath(A.id, "0000-01-01"), { as: A.owner });
      expect(zero.status).toBe(400);
      expect(zero.json.error?.code).toBe("validation_failed");
      const other = await request("GET", totalsPath(B.id, fx.day.d0), { as: A.owner });
      expect(other.status).toBe(404);
      expect(other.json.error?.code).toBe("tenant_not_found");
      const anonymous = await request("GET", totalsPath(A.id, fx.day.d0));
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("the day's CSV export", () => {
    async function exported(as: string, date = fx.day.d0, tenantId = A.id) {
      const res = await request("GET", exportPath(tenantId, date), { as });
      expect(res.status, res.text).toBe(200);
      return res;
    }

    it("is a no-store attachment named by operator and date only", async () => {
      const res = await exported(A.owner);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="${A.slug}-bookings-${fx.day.d0}.csv"`,
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.text.endsWith("\r\n")).toBe(true);
      expect(res.text.replaceAll("\r\n", "")).not.toMatch(/\n/);
    });

    it("gives owners and booking staff the booker's columns and finance the financial ones only", async () => {
      const owner = parseCsv((await exported(A.owner)).text);
      const staff = parseCsv((await exported(A.staff)).text);
      const finance = parseCsv((await exported(A.finance)).text);
      expect(owner[0]).toEqual([...bookingDayExportColumns, ...bookingDayExportGuestColumns]);
      expect(staff[0]).toEqual(owner[0]);
      expect(finance[0]).toEqual([...bookingDayExportColumns]);
      // The same rows and money, less the two booker columns. Each export
      // names its own generation time, so that column is left out.
      const generated = bookingDayExportColumns.indexOf("Generated at (UTC)");
      const financial = (rows: string[][]) =>
        rows.map((r) =>
          r.slice(0, bookingDayExportColumns.length).filter((_, i) => i !== generated),
        );
      expect(financial(finance)).toEqual(financial(owner));
      const financeText = (await exported(A.finance)).text;
      for (const fragment of personal) {
        expect(financeText, fragment).not.toContain(fragment);
      }
    });

    it("has one row per booking with its order's money and a total row equal to the ledger", async () => {
      const rows = parseCsv((await exported(A.owner)).text);
      const header = rows[0] ?? [];
      const col = (r: string[] | undefined, name: string) => r?.[header.indexOf(name)];
      const bookingRows = rows.slice(1, -1);
      const total = rows.at(-1);
      // By departure, then trip, then confirmation: the charter and the shared
      // trip both leave at 10:00, so the trip id decides between them.
      const order = await admin<{ reference: string }[]>`
        select b.reference from public.bookings b
          join public.scheduled_trips t on t.id = b.trip_id
         where b.tenant_id = ${A.id} and t.local_date = ${fx.day.d0}::date
         order by t.starts_at, t.id, b.confirmed_at, b.id`;
      expect(bookingRows.map((r) => col(r, "Booking reference"))).toEqual(
        order.map((r) => r.reference),
      );
      expect(new Set(order.map((r) => r.reference))).toEqual(
        new Set([fx.rich.reference, fx.single.reference, fx.pair.reference, fx.charter.reference]),
      );
      for (const r of bookingRows) {
        expect(col(r, "Row")).toBe("Booking");
        expect(col(r, "Operator")).toBe(`Inventory ${A.slug}`);
        expect(col(r, "Departure date")).toBe(fx.day.d0);
        expect(col(r, "Time zone")).toBe("UTC");
        expect(col(r, "Booking state")).toBe("confirmed");
        expect(col(r, "Payment state")).toBe("succeeded");
        expect(col(r, "Currency")).toBe("USD");
        expect(col(r, "Pending refunds")).toBe("0.00");
        // The departure's exact instant, from the trip (review data F5).
        const [trip] = await admin<{ at: string }[]>`
          select to_char(t.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as at
            from public.bookings b join public.scheduled_trips t on t.id = b.trip_id
           where b.tenant_id = ${A.id} and b.reference = ${col(r, "Booking reference") ?? ""}`;
        expect(col(r, "Departure at (UTC)")).toBe(trip?.at);
        const [order] = await admin<
          {
            subtotal_amount: number;
            discount_amount: number;
            fee_amount: number;
            tax_amount: number;
            total_amount: number;
            included_tax_amount: number;
            party_size: number;
          }[]
        >`select o.*, b.party_size from public.orders o join public.bookings b on b.order_id = o.id
           where b.tenant_id = ${A.id} and b.reference = ${col(r, "Booking reference") ?? ""}`;
        expect({
          guests: Number(col(r, "Guests")),
          gross: cents(col(r, "Gross")),
          discounts: cents(col(r, "Discounts")),
          fees: cents(col(r, "Fees")),
          taxes: cents(col(r, "Added taxes")),
          total: cents(col(r, "Total")),
          included: cents(col(r, "Included tax")),
          net: cents(col(r, "Net")),
        }).toEqual({
          guests: order?.party_size,
          gross: order?.subtotal_amount,
          discounts: order?.discount_amount,
          fees: order?.fee_amount,
          taxes: order?.tax_amount,
          total: order?.total_amount,
          included: order?.included_tax_amount,
          net: order?.total_amount,
        });
      }
      const { pendingRefunds, ...ledger } = await ledgerTotals(A.id, fx.day.d0);
      expect(col(total, "Row")).toBe("Total");
      expect({
        bookings: Number(col(total, "Bookings")),
        guests: Number(col(total, "Guests")),
        gross: cents(col(total, "Gross")),
        discounts: cents(col(total, "Discounts")),
        fees: cents(col(total, "Fees")),
        taxes: cents(col(total, "Added taxes")),
        total: cents(col(total, "Total")),
        refunds: cents(col(total, "Refunds")),
        net: cents(col(total, "Net")),
        includedTax: cents(col(total, "Included tax")),
      }).toEqual(ledger);
      expect(cents(col(total, "Pending refunds"))).toBe(pendingRefunds.amount);
      // The on-screen totals and the export's total row are the same figures.
      const shown = BookingDayTotalsResponse.parse(
        (await request("GET", totalsPath(A.id, fx.day.d0), { as: A.finance })).json,
      ).totals;
      expect(cents(col(total, "Net"))).toBe(shown.net);
      expect(cents(col(total, "Gross"))).toBe(shown.gross);
    });

    it("carries refunds and their states, and leaves a pending refund out of net", async () => {
      const rows = parseCsv((await exported(A.finance, fx.day.d2)).text);
      const header = rows[0] ?? [];
      const col = (r: string[] | undefined, name: string) => r?.[header.indexOf(name)];
      const byRef = (ref: string) => rows.find((r) => col(r, "Booking reference") === ref);
      const refunded = byRef(fx.refunded.reference);
      expect(col(refunded, "Refund state")).toBe("succeeded");
      expect(cents(col(refunded, "Refunds"))).toBe(cents(col(refunded, "Total")));
      expect(cents(col(refunded, "Net"))).toBe(0);
      const pending = byRef(fx.pending.reference);
      expect(col(pending, "Refund state")).toBe("requested");
      expect(cents(col(pending, "Refunds"))).toBe(0);
      // Its own column, so the total row carries the screen's pending figure (review UI-5).
      expect(cents(col(pending, "Pending refunds"))).toBe(cents(col(pending, "Total")));
      expect(cents(col(refunded, "Pending refunds"))).toBe(0);
      expect(cents(col(pending, "Net"))).toBe(cents(col(pending, "Total")));
      const ledger = await ledgerTotals(A.id, fx.day.d2);
      expect(cents(col(rows.at(-1), "Refunds"))).toBe(ledger.refunds);
      expect(cents(col(rows.at(-1), "Pending refunds"))).toBe(ledger.pendingRefunds.amount);
      expect(cents(col(rows.at(-1), "Net"))).toBe(ledger.net);
      const shown = BookingDayTotalsResponse.parse(
        (await request("GET", totalsPath(A.id, fx.day.d2), { as: A.finance })).json,
      ).totals;
      expect(cents(col(rows.at(-1), "Pending refunds"))).toBe(shown.pendingRefunds.amount);
    });

    it("refuses a day with more bookings than one report holds, with its own code and no audit", async () => {
      // An app whose limit is one booking, so the rich day's four are too many.
      const small = createApp({ accessVerifier: verifier, dayReportLimit: 1 });
      const before = await admin<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where tenant_id = ${A.id} and action = 'booking_day.exported'`;
      for (const path of [totalsPath(A.id, fx.day.d0), exportPath(A.id, fx.day.d0)]) {
        const res = await request("GET", path, { as: A.owner, via: small });
        expect(res.status, path).toBe(422);
        expect(res.json.error?.code).toBe("day_too_large");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-disposition")).toBeNull();
      }
      const after = await admin<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where tenant_id = ${A.id} and action = 'booking_day.exported'`;
      expect(after[0]?.n).toBe(before[0]?.n);
      // A day within the limit still answers.
      const one = await request("GET", totalsPath(A.id, fx.day.empty), { as: A.owner, via: small });
      expect(one.status).toBe(200);
    });

    it("keeps a booker's name from running as a spreadsheet formula", async () => {
      const rows = parseCsv((await exported(A.owner, fx.day.d1)).text);
      const header = rows[0] ?? [];
      const row = rows.find((r) => r[header.indexOf("Booking reference")] === fx.formula.reference);
      expect(row?.[header.indexOf("Booker name")]).toBe(`'${people.formula.name}`);
    });

    it("exports a day with no bookings as a header and a zero total row", async () => {
      const rows = parseCsv((await exported(A.staff, fx.day.empty)).text);
      expect(rows).toHaveLength(2);
      expect(rows[1]?.[0]).toBe("Total");
    });

    it("records each export in the audit history, without personal data", async () => {
      const before = await admin<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where tenant_id = ${A.id} and action = 'booking_day.exported'`;
      await exported(A.finance, fx.day.d1);
      await exported(A.staff, fx.day.d1);
      const rows = await admin<
        { actor_type: string; subject_type: string; subject_id: string; after_state: unknown }[]
      >`select actor_type, subject_type, subject_id, after_state from public.audit_events
         where tenant_id = ${A.id} and action = 'booking_day.exported'
         order by id desc limit 2`;
      const [after] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where tenant_id = ${A.id} and action = 'booking_day.exported'`;
      expect((after?.n ?? 0) - (before[0]?.n ?? 0)).toBe(2);
      expect(rows).toEqual([
        {
          actor_type: "staff",
          subject_type: "booking_day",
          subject_id: fx.day.d1,
          after_state: { rows: 2, withGuestDetails: true },
        },
        {
          actor_type: "staff",
          subject_type: "booking_day",
          subject_id: fx.day.d1,
          after_state: { rows: 2, withGuestDetails: false },
        },
      ]);
    });

    it("never carries another operator's bookings, and answers another tenant as unknown", async () => {
      const text = (await exported(A.owner)).text;
      expect(text).not.toContain(fx.bMaya.reference);
      expect(text).not.toContain(fx.bBea.reference);
      expect(text).not.toContain("Bea Elsewhere");
      const other = await request("GET", exportPath(B.id, fx.day.d0), { as: A.finance });
      expect(other.status).toBe(404);
      expect(other.json.error?.code).toBe("tenant_not_found");
      expect(other.headers.get("content-disposition")).toBeNull();
      const anonymous = await request("GET", exportPath(A.id, fx.day.d0));
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("cache-control")).toBe("no-store");
    });
  });

  // Notes ------------------------------------------------------------------------------------------

  describe("notes", () => {
    it("lets owners and booking staff add and read notes, newest first", async () => {
      const first = await addNote(A.id, fx.pair.bookingId, A.owner, {
        body: "  Guest called: two more may join.\nAsked about parking.  ",
      });
      expect(first.status, first.text).toBe(201);
      expect(first.headers.get("cache-control")).toBe("no-store");
      const note = BookingNoteCreatedResponse.parse(first.json).note;
      expect(note.author.name).toBe("Olive Owner");
      // The answer names the note without its text (review code F4).
      expect(keysOf(first.json).has("body")).toBe(false);
      const second = await addNote(A.id, fx.pair.bookingId, A.staff, {
        body: "Confirmed parking.",
      });
      expect(second.status).toBe(201);
      expect(BookingNoteCreatedResponse.parse(second.json).note.author.name).toBe("Sam Desk");

      for (const as of [A.owner, A.staff]) {
        const res = await request("GET", notesPath(A.id, fx.pair.bookingId), { as });
        expect(res.status, res.text).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = BookingNotesResponse.parse(res.json);
        expect(body.total).toBe(2);
        expect(body.notes.map((n) => n.body)).toEqual([
          "Confirmed parking.",
          "Guest called: two more may join.\nAsked about parking.",
        ]);
        expect(body.notes[1]?.id).toBe(note.id);
      }
    });

    it("never lets finance read or write a note (the owner's decision of 2026-10-19)", async () => {
      const read = await request("GET", notesPath(A.id, fx.pair.bookingId), { as: A.finance });
      expect(read.status).toBe(403);
      expect(read.json.error?.code).toBe("forbidden");
      expect(read.headers.get("cache-control")).toBe("no-store");
      expect(read.text).not.toContain("parking");
      const res = await addNote(A.id, fx.pair.bookingId, A.finance, { body: "Finance note" });
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toBe("forbidden");
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.booking_notes where body = 'Finance note'`;
      expect(row?.n).toBe(0);
    });

    it("authors a note from the signed-in member, with the database's time", async () => {
      const before = Date.now();
      const res = await addNote(A.id, fx.single.bookingId, A.staff, {
        body: "Wheelchair access asked.",
      });
      const note = BookingNoteCreatedResponse.parse(res.json).note;
      const [row] = await admin<
        { author_user_id: string; email: string; request_id: string | null }[]
      >`
        select n.author_user_id, u.email, n.request_id from public.booking_notes n
          join public.staff_users u on u.id = n.author_user_id where n.id = ${note.id}`;
      expect(row?.email).toBe(A.staff);
      expect(row?.author_user_id).toBe(note.author.userId);
      expect(row?.request_id).toBe(res.headers.get("x-request-id"));
      expect(Date.parse(note.createdAt)).toBeGreaterThan(before - 60_000);
    });

    it("replays the same key once and refuses it with another body", async () => {
      const key = `note-${randomUUID()}`;
      const first = await addNote(
        A.id,
        fx.charter.bookingId,
        A.owner,
        { body: "Cake on board." },
        key,
      );
      const again = await addNote(
        A.id,
        fx.charter.bookingId,
        A.owner,
        { body: "Cake on board." },
        key,
      );
      expect(again.status).toBe(201);
      expect(again.headers.get("idempotent-replayed")).toBe("true");
      expect(again.json).toEqual(first.json);
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.booking_notes where booking_id = ${fx.charter.bookingId}`;
      expect(row?.n).toBe(1);
      // The response kept for the replay holds the note's id, not its text.
      const kept = await admin<{ response_body: unknown }[]>`
        select response_body from public.idempotency_keys
         where tenant_id = ${A.id} and scope = 'bookings.notes.add' and key = ${key}`;
      expect(kept).toHaveLength(1);
      expect(JSON.stringify(kept[0]?.response_body)).not.toContain("Cake");
      expect(JSON.stringify(kept[0]?.response_body)).toContain(
        BookingNoteCreatedResponse.parse(first.json).note.id,
      );
      const changed = await addNote(
        A.id,
        fx.charter.bookingId,
        A.owner,
        { body: "Pie instead." },
        key,
      );
      expect(changed.status).toBe(422);
      expect(changed.json.error?.code).toBe("idempotency_key_reused");
    });

    it("refuses an empty, long, or control-character note, and a missing key or origin", async () => {
      for (const body of [
        { body: "" },
        { body: "   \n  " },
        { body: "x".repeat(501) },
        { body: "tab\there" },
        { body: "bell\u0007" },
        // C1 controls, and text that shows nothing (review code F2).
        { body: "a\u0090b" },
        { body: "\u0085" },
        { body: "\u200b" },
        { body: "\u2060\ufeff" },
        {},
      ]) {
        const res = await addNote(A.id, fx.rich.bookingId, A.owner, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const keyless = await request("POST", notesPath(A.id, fx.rich.bookingId), {
        origin: CONSOLE,
        as: A.owner,
        body: { body: "No key" },
      });
      expect(keyless.status).toBe(400);
      const foreign = await request("POST", notesPath(A.id, fx.rich.bookingId), {
        origin: "https://evil.example",
        as: A.owner,
        body: { body: "From elsewhere" },
        headers: { "idempotency-key": `note-${randomUUID()}` },
      });
      expect(foreign.status).toBe(403);
      expect(foreign.json.error?.code).toBe("origin_not_allowed");
      // Refused by a guard before the route, and still never cached (review data F2).
      expect(foreign.headers.get("cache-control")).toBe("no-store");
      const exact = await addNote(A.id, fx.rich.bookingId, A.owner, { body: "y".repeat(500) });
      expect(exact.status).toBe(201);
    });

    it("answers another operator's booking exactly as an unknown one", async () => {
      await addNote(B.id, fx.bBea.bookingId, B.owner, { body: "B's private note." });
      const answers = [];
      for (const bookingId of [fx.bBea.bookingId, randomUUID(), "not-a-uuid"]) {
        const read = await request("GET", notesPath(A.id, bookingId), { as: A.owner });
        const write = await addNote(A.id, bookingId, A.owner, { body: "Probe" });
        answers.push([read.status, read.json.error?.code, write.status, write.json.error?.code]);
      }
      expect(answers).toEqual(Array(3).fill([404, "booking_not_found", 404, "booking_not_found"]));
      const viaB = await request("GET", notesPath(B.id, fx.bBea.bookingId), { as: A.owner });
      expect(viaB.status).toBe(404);
      expect(viaB.json.error?.code).toBe("tenant_not_found");
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.booking_notes where body = 'Probe'`;
      expect(row?.n).toBe(0);
    });

    it("records each note in the audit history by id, never by its text", async () => {
      // The marker holds a space and letters outside hex, so no id, number, or
      // timestamp in the audit history can contain it by chance (a digit run
      // like 7731 can sit inside a uuid or a timestamp).
      const res = await addNote(A.id, fx.formula.bookingId, A.owner, {
        body: "Secret phrase zqxjv.",
      });
      const note = BookingNoteCreatedResponse.parse(res.json).note;
      const rows = await admin<{ action: string; subject_id: string; after_state: unknown }[]>`
        select action, subject_id, after_state from public.audit_events
         where tenant_id = ${A.id} and subject_type = 'booking' and subject_id = ${fx.formula.bookingId}
           and action = 'booking.note_added'`;
      expect(rows).toEqual([
        {
          action: "booking.note_added",
          subject_id: fx.formula.bookingId,
          after_state: { noteId: note.id },
        },
      ]);
      const [leak] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.audit_events a
         where a.tenant_id = ${A.id} and a::text ilike '%phrase zqxjv%'`;
      expect(leak?.n).toBe(0);
    });
  });

  // The calendar's date query (a G2.12b follow-up) -------------------------------------------------

  describe("the calendar's trips query", () => {
    it("refuses year 0000 in the contract, as the day list does, and still answers real dates", async () => {
      for (const query of [
        { from: "0000-01-01", to: "0000-01-07" },
        { from: "0000-12-31", to: fx.day.d0 },
      ]) {
        const res = await request("GET", `${staffBase(A.id)}/trips?${new URLSearchParams(query)}`, {
          as: A.owner,
        });
        expect(res.status, JSON.stringify(query)).toBe(400);
        expect(res.json.error?.code).toBe("validation_failed");
      }
      const week = await request(
        "GET",
        `${staffBase(A.id)}/trips?${new URLSearchParams({ from: fx.day.d0, to: fx.day.d2 })}`,
        { as: A.finance },
      );
      expect(week.status).toBe(200);
      expect((week.json.trips as unknown[]).length).toBeGreaterThan(0);
    });
  });

  // The notes table itself ---------------------------------------------------------------------------

  describe("the booking_notes table", () => {
    const staffContext = (tenantId: string, userId: string) => ({
      tenantId,
      actorType: "staff" as const,
      actorId: userId,
      requestId: `req-${randomUUID()}`,
    });

    async function userIdOf(email: string): Promise<string> {
      const [row] = await admin<
        { id: string }[]
      >`select id from public.staff_users where email = ${email}`;
      if (!row) throw new Error(`no user ${email}`);
      return row.id;
    }

    it("keeps every note for every role: no update, delete, or truncate", async () => {
      const res = await addNote(A.id, fx.refunded.bookingId, A.owner, {
        body: "Refund explained.",
      });
      const id = BookingNoteCreatedResponse.parse(res.json).note.id;
      const ownerId = await userIdOf(A.owner);
      for (const statement of [
        sql`update booking_notes set body = 'Changed' where id = ${id}::uuid`,
        sql`delete from booking_notes where id = ${id}::uuid`,
      ]) {
        await expect(
          inTenantTransaction(runtime.db, staffContext(A.id, ownerId), (trx) =>
            statement.execute(trx),
          ),
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        admin`update public.booking_notes set body = 'Changed' where id = ${id}`,
      ).rejects.toThrow(/append-only/);
      await expect(admin`delete from public.booking_notes where id = ${id}`).rejects.toThrow(
        /append-only/,
      );
      await expect(admin`truncate public.booking_notes`).rejects.toThrow(/append-only/);
      const [row] = await admin<
        { body: string }[]
      >`select body from public.booking_notes where id = ${id}`;
      expect(row?.body).toBe("Refund explained.");
    });

    it("stamps the author from the transaction, whatever the insert names", async () => {
      const staffId = await userIdOf(A.staff);
      const ownerId = await userIdOf(A.owner);
      const written = await inTenantTransaction(runtime.db, staffContext(A.id, staffId), (trx) =>
        trx
          .insertInto("booking_notes")
          .values({
            tenant_id: A.id,
            booking_id: fx.rich.bookingId,
            body: "Named another author",
            author_user_id: ownerId,
            created_at: new Date("2001-01-01"),
          } as never)
          .returning(["author_user_id", "created_at"])
          .executeTakeFirstOrThrow(),
      );
      expect(written.author_user_id).toBe(staffId);
      expect(written.created_at.getUTCFullYear()).toBeGreaterThan(2001);
    });

    it("refuses C1 controls and text that shows nothing, even past the API", async () => {
      const ownerId = await userIdOf(A.owner);
      for (const body of ["a\u0090b", "\u0085", "\u200b", "\u2060\ufeff", "\u3164", " \n "]) {
        await expect(
          inTenantTransaction(runtime.db, staffContext(A.id, ownerId), (trx) =>
            trx
              .insertInto("booking_notes")
              .values({ tenant_id: A.id, booking_id: fx.rich.bookingId, body })
              .execute(),
          ),
          JSON.stringify(body),
        ).rejects.toThrow(/check constraint/);
      }
      // Line breaks, accents, and emoji are visible text.
      for (const body of ["Two lines\nhere", "José Núñez", "👍"]) {
        await inTenantTransaction(runtime.db, staffContext(A.id, ownerId), (trx) =>
          trx
            .insertInto("booking_notes")
            .values({ tenant_id: A.id, booking_id: fx.rich.bookingId, body })
            .execute(),
        );
      }
    });

    it("refuses a note without a staff actor, for every role", async () => {
      await expect(
        inTenantTransaction(runtime.db, guestContext(A.id), (trx) =>
          trx
            .insertInto("booking_notes")
            .values({ tenant_id: A.id, booking_id: fx.rich.bookingId, body: "Guest" })
            .execute(),
        ),
      ).rejects.toThrow(/written by a signed-in staff member/);
      await expect(
        admin`insert into public.booking_notes (tenant_id, booking_id, body)
                values (${A.id}, ${fx.rich.bookingId}, 'Admin without context')`,
      ).rejects.toThrow(/written by a signed-in staff member/);
    });

    it("cannot point at another tenant's booking or be read across tenants", async () => {
      const ownerId = await userIdOf(A.owner);
      await expect(
        inTenantTransaction(runtime.db, staffContext(A.id, ownerId), (trx) =>
          trx
            .insertInto("booking_notes")
            .values({ tenant_id: A.id, booking_id: fx.bBea.bookingId, body: "Cross-tenant" })
            .execute(),
        ),
      ).rejects.toThrow(/foreign key/);
      // A member of B only cannot author a note at A.
      const bOwnerId = await userIdOf(B.owner);
      await expect(
        inTenantTransaction(runtime.db, staffContext(A.id, bOwnerId), (trx) =>
          trx
            .insertInto("booking_notes")
            .values({ tenant_id: A.id, booking_id: fx.rich.bookingId, body: "Not a member here" })
            .execute(),
        ),
      ).rejects.toThrow(/foreign key/);
      const seen = await inTenantTransaction(runtime.db, staffContext(A.id, ownerId), (trx) =>
        trx.selectFrom("booking_notes").select(["tenant_id"]).execute(),
      );
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen.map((r) => r.tenant_id))).toEqual(new Set([A.id]));
    });
  });
});
