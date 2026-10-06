/**
 * G2.12b acceptance and adversarial tests for the console's booking reads,
 * through the whole API as tidegrid_app: a day's bookings, one booking in
 * detail, a lookup by reference, a trip's roster, and the paged finalization
 * exceptions. Every booking and exception here is made the only way the system
 * makes one: a real public checkout, the fake provider's controls, and its
 * signed webhook. The suite checks each role's view of each route, with
 * finance never receiving a booker; two tenants on every route, where another
 * tenant's id answers exactly as an unknown one does; keyset pages that
 * neither overlap nor skip; money that adds up; and no secret, key, hash, or
 * full provider id in any response.
 *
 * Two fixtures rewrite stored bookings, which the database otherwise keeps
 * append-only, because no request can produce them on demand: confirmation
 * instants that tie exactly or share one millisecond, and one reference that
 * holds 0 and 1 and that both tenants issued. The append-only trigger is off
 * only inside the admin transaction that makes the change, and the setup
 * checks that it is on again afterward.
 */
import { randomUUID } from "node:crypto";
import {
  BookingDetailResponse,
  BookingListResponse,
  BookingReferenceResponse,
  FinalizationExceptionsResponse,
  type Quote,
  TripRosterResponse,
} from "@tidegrid/contracts";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  backdateCheckout,
  type CheckoutFixture,
  craftedFakeEventBody,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { systemContext } from "@tidegrid/domain-inventory/testing";
import {
  type PaymentProvider,
  ProviderUnavailableError,
  signatureHeaderValue,
} from "@tidegrid/domain-payments";
import {
  createPriceListVersion,
  createQuote,
  createTaxRate,
  type PartySelection,
} from "@tidegrid/domain-pricing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
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
type Outcome = "confirmed" | "confirmed_reacquired" | "payment_mismatch" | "refund_required";

interface Opened {
  tripId: string;
  quote: Quote;
  booker: Booker;
  sessionId: string;
  amount: number;
  secret: string;
  key: string;
  paymentRef: string;
  clientSecret: string;
  paymentId: string;
}
interface Made extends Opened {
  bookingId: string;
  reference: string;
}

const env = inject("integrationDb");
const TEAM = "tidegrid-console-bookings.cloudflareaccess.com";
const AUD = "b2".repeat(32);
/** The reference both tenants' rewritten bookings carry. It holds a 0 and a 1. */
const TWIN = "Q0Q1ZZ10";
/** Microseconds after one whole millisecond, for the six tied confirmations. */
const TIE_OFFSETS = [0, 0, 0, 1, 999, 1000] as const;
/** A masked fake payment id: the prefix, a mask, and the last four characters. */
const MASKED = /^fpay_[^A-Za-z0-9]+[A-Za-z0-9]{4}$/;

const booker = (tag: string): Booker => ({
  name: `Synthetic Booker ${tag}`,
  email: `synthetic.booker.${tag.toLowerCase()}@example.test`,
});
const adults = (n: number): PartySelection => ({
  kind: "tickets",
  tickets: [{ code: "adult", quantity: n }],
});
const aboard = (n: number): PartySelection => ({ kind: "charter", guests: n });
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const iso = (d: Date) => d.toISOString();

function at<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) throw new Error(`fixture has no item ${i}`);
  return value;
}

/** A deep copy without one key at any depth. */
function withoutKey(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutKey(v, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== key)
        .map(([k, v]) => [k, withoutKey(v, key)]),
    );
  }
  return value;
}

/** What a client can tell apart: the status and the body, less the per-request id. */
const answer = (r: Res) => ({ status: r.status, body: withoutKey(r.json, "requestId") });
const refusal = (status: number, code: string) => ({
  status,
  body: { error: { code, message: expect.any(String) } },
});

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

describe.skipIf(!env)("G2.12b console booking reads through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: Tenant;
  let B: Tenant;
  const kid = `kid-${randomUUID().slice(0, 8)}`;
  let addressCount = 0;

  interface Fixtures {
    day: { d0: string; d1: string; d2: string; d3: string; d4: string; d5: string };
    /** D6: nothing booked until the last test races confirmations against reads. */
    raceDay: string;
    /** D6, Harbor Seats: eight one-seat checkouts left open for that race. */
    racing: Opened[];
    bDay0: string;
    /** D0, Harbor Seats: two adults and a child, two add-ons, the promotion. */
    rich: Made;
    /** D0, Harbor Seats: one adult. Its reference is rewritten to TWIN. */
    single: Made;
    /** D0, Harbor Seats: two adults. */
    pair: Made;
    /** D0, Wren Charter: four guests. */
    charter: Made;
    /** D1: eight one-seat bookings and one charter, all paid at once. */
    crowd: Made[];
    /** D2: six one-seat bookings whose confirmations are rewritten to tie. */
    ties: Made[];
    /** D3, Harbor Seats: paid after its hold lapsed; the seats were still free. */
    reacquired: Made;
    /** D3, Wren Charter: took the boat while an earlier checkout had lapsed. */
    taker: Made;
    /** D3, Wren Charter: paid after the boat was taken. Refunded, no_capacity. */
    lost: Opened;
    /** D4: paid after the guest canceled. Refunded, session_canceled. */
    canceled: Opened;
    /** D4: a verified success for the wrong amount. Not refunded, payment_mismatch. */
    mismatched: Opened;
    exceptionIds: { lost: string; canceled: string; mismatched: string };
    /** B, its D0: two adults. Its reference is rewritten to TWIN. */
    bPair: Made;
    bSingle: Made;
    /** B: paid after the guest canceled; refunded. */
    bCanceled: Opened;
    /** B: paid after the guest canceled; the provider refused the refund. */
    bRefused: Opened;
    /** B: paid after the guest canceled; the provider never answered the refund. */
    bUnanswered: Opened;
    /** B's exceptions, newest first: unanswered, refused, canceled. */
    bExceptionIds: { canceled: string; refused: string; unanswered: string };
    /** Finance at A and owner at B. */
    twoHats: string;
    /** An owner of A whose membership is disabled. */
    disabledOwner: string;
  }
  let fx: Fixtures;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: "https://console.test",
    STAFF_ORIGINS: "https://console.test",
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
      raw?: string;
      headers?: Record<string, string>;
      /** Another app instance, such as one whose provider refuses refunds. */
      via?: ReturnType<typeof createApp>;
    } = {},
  ): Promise<Res> {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
    if (opts.body !== undefined || opts.raw !== undefined) {
      headers.set("content-type", "application/json");
    }
    const res = await (opts.via ?? app).request(
      `http://localhost${path}`,
      {
        method,
        headers,
        body: opts.raw ?? (opts.body === undefined ? null : JSON.stringify(opts.body)),
      },
      bindings(),
      executionCtx,
    );
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = {};
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  const get = (path: string, as?: string) => request("GET", path, as ? { as } : {});

  // Paths -------------------------------------------------------------------------------

  const staffBase = (tenantId: string) => `/v1/staff/tenants/${encodeURIComponent(tenantId)}`;
  function dayPath(
    tenantId: string,
    q: { date?: string; tripId?: string; limit?: number | string; after?: string },
  ): string {
    const params = new URLSearchParams();
    if (q.date !== undefined) params.set("date", q.date);
    if (q.tripId !== undefined) params.set("tripId", q.tripId);
    if (q.limit !== undefined) params.set("limit", String(q.limit));
    if (q.after !== undefined) params.set("after", q.after);
    return `${staffBase(tenantId)}/bookings?${params}`;
  }
  const detailPath = (tenantId: string, bookingId: string) =>
    `${staffBase(tenantId)}/bookings/${encodeURIComponent(bookingId)}`;
  const referencePath = (tenantId: string, reference: string) =>
    `${staffBase(tenantId)}/booking-references/${encodeURIComponent(reference)}`;
  const rosterPath = (tenantId: string, tripId: string) =>
    `${staffBase(tenantId)}/trips/${encodeURIComponent(tripId)}/roster`;
  function exceptionsPath(tenantId: string, q: { limit?: number | string; before?: string } = {}) {
    const params = new URLSearchParams();
    if (q.limit !== undefined) params.set("limit", String(q.limit));
    if (q.before !== undefined) params.set("before", q.before);
    const query = params.toString();
    return `${staffBase(tenantId)}/finalization-exceptions${query ? `?${query}` : ""}`;
  }

  // Fixtures through the real checkout ---------------------------------------------------

  const guest = (t: Tenant) => `https://${t.host}`;
  /** A distinct documentation address per checkout, so every checkout stores a client key. */
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

  async function open(t: Tenant, q: Quote, who: Booker): Promise<Opened> {
    const secret = newSecret();
    const key = `chk-${randomUUID()}`;
    const res = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(t),
      body: {
        quoteId: q.quoteId,
        acceptedPolicyVersion: q.policy.version,
        booker: who,
        checkoutSecret: secret,
      },
      headers: { "idempotency-key": key, "cf-connecting-ip": nextAddress() },
    });
    const session = res.json.checkoutSession as { id: string; amount: number } | undefined;
    const payment = res.json.payment as { paymentRef: string; clientSecret: string } | null;
    if (res.status !== 201 || !session || !payment) {
      throw new Error(`open: ${res.status} ${res.text}`);
    }
    const [row] = await admin<{ id: string }[]>`
      select id from public.payments where checkout_session_id = ${session.id}`;
    if (!row) throw new Error("open: no payment row");
    return {
      tripId: q.tripId,
      quote: q,
      booker: who,
      sessionId: session.id,
      amount: session.amount,
      secret,
      key,
      paymentRef: payment.paymentRef,
      clientSecret: payment.clientSecret,
      paymentId: row.id,
    };
  }

  async function settle(
    t: Tenant,
    o: Opened,
    expected: "confirmed" | "confirmed_reacquired" | "refund_required",
  ) {
    const res = await request("POST", `/v1/fake-provider/payments/${o.paymentRef}/succeed`, {
      origin: guest(t),
      headers: { authorization: `Bearer ${o.clientSecret}` },
    });
    const delivery = res.json.delivery as { outcome?: string | null } | null | undefined;
    if (res.status !== 200 || delivery?.outcome !== expected) {
      throw new Error(`settle: wanted ${expected}, got ${res.status} ${res.text}`);
    }
  }

  async function bookingOf(o: Opened): Promise<Made> {
    const [row] = await admin<{ id: string; reference: string }[]>`
      select id, reference from public.bookings where checkout_session_id = ${o.sessionId}`;
    if (!row) throw new Error(`no booking for checkout ${o.sessionId}`);
    return { ...o, bookingId: row.id, reference: row.reference };
  }

  async function book(t: Tenant, q: Quote, who: Booker): Promise<Made> {
    const o = await open(t, q, who);
    await settle(t, o, "confirmed");
    return bookingOf(o);
  }

  async function cancel(t: Tenant, o: Opened) {
    const res = await request("POST", `/v1/public/checkout-sessions/${o.sessionId}/cancel`, {
      origin: guest(t),
      headers: { authorization: `Bearer ${o.secret}` },
    });
    if (res.status !== 200) throw new Error(`cancel: ${res.status} ${res.text}`);
  }

  /**
   * A verified success for the payment, posted straight to the webhook as the
   * provider would sign it: for its amount, or for another one.
   */
  async function deliver(
    t: Tenant,
    o: Opened,
    expected: readonly Outcome[],
    opts: { amount?: number; via?: ReturnType<typeof createApp> } = {},
  ) {
    const body = craftedFakeEventBody({
      type: "payment.succeeded",
      accountRef: t.accountRef,
      paymentRef: o.paymentRef,
      amount: opts.amount ?? o.amount,
      clientReference: o.paymentId,
    });
    const res = await request("POST", "/v1/webhooks/payments/fake", {
      raw: body,
      headers: { "fake-signature": await signatureHeaderValue(TEST_FAKE_SECRET, Date.now(), body) },
      ...(opts.via ? { via: opts.via } : {}),
    });
    const outcome = res.json.outcome as Outcome | undefined;
    if (res.status !== 200 || outcome === undefined || !expected.includes(outcome)) {
      throw new Error(`deliver: wanted ${expected.join(" or ")}, got ${res.status} ${res.text}`);
    }
  }

  /**
   * An app whose payment provider is the fake in every way but refunds: it
   * refuses them, or never answers, as a real provider can.
   */
  function appWhoseRefunds(outcome: "are refused" | "go unanswered") {
    return createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [] }),
      }),
      paymentProvider: (db): PaymentProvider => {
        const fake = fakeProvider(db);
        return {
          name: fake.name,
          signatureHeader: fake.signatureHeader,
          minimumAmount: (currency) => fake.minimumAmount(currency),
          createPayment: (input) => fake.createPayment(input),
          retrievePayment: (input) => fake.retrievePayment(input),
          verifyWebhook: (input) => fake.verifyWebhook(input),
          refundPayment: async () => {
            if (outcome === "go unanswered") {
              throw new ProviderUnavailableError("the provider did not answer");
            }
            return {
              refundRef: "frf_refused",
              status: "failed",
              failureCode: "insufficient_funds",
            };
          },
        };
      },
    });
  }

  async function exceptionOf(o: Opened): Promise<string> {
    const [row] = await admin<{ id: string }[]>`
      select id from public.finalization_exceptions where checkout_session_id = ${o.sessionId}`;
    if (!row) throw new Error(`no exception for checkout ${o.sessionId}`);
    return row.id;
  }

  async function member(
    tenantId: string,
    email: string,
    role: "owner" | "booking_staff" | "finance",
    status: "active" | "disabled" = "active",
  ): Promise<string> {
    const [found] = await admin<{ id: string }[]>`
      select id from public.staff_users where email = ${email}`;
    const userId = found?.id ?? randomUUID();
    if (!found) {
      await admin`insert into public.staff_users (id, email, display_name)
        values (${userId}, ${email}, ${role})`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name, status)
      values (${tenantId}, ${userId}, ${role}, ${role}, ${status})`;
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
      owner: await member(f.id, mail("owner"), "owner"),
      staff: await member(f.id, mail("staff"), "booking_staff"),
      finance: await member(f.id, mail("finance"), "finance"),
    };
  }

  /**
   * A's shared trips sell adults and children, a per-guest port fee, and two
   * add-ons, and A charges a 5% tax inside its prices beside the fixture's
   * 7% added tax, so one order carries every kind of line.
   */
  async function richTerms(t: Tenant) {
    const ctx = systemContext(t.id, "g212b-fixture");
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
          {
            code: "photo",
            name: "Souvenir photo",
            unitAmount: 900,
            quantityRule: "per_booking",
            maxQuantity: 2,
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
   * Change stored bookings that the database keeps append-only. The trigger
   * is off only inside this one admin transaction; afterward it must be on.
   */
  async function rewriteBookings(work: (tx: postgres.TransactionSql) => Promise<void>) {
    await admin.begin(async (tx) => {
      await tx`alter table public.bookings disable trigger bookings_append_only`;
      await work(tx);
      await tx`alter table public.bookings enable trigger bookings_append_only`;
    });
    const [trigger] = await admin<{ enabled: string }[]>`
      select tgenabled as enabled from pg_trigger
       where tgname = 'bookings_append_only' and tgrelid = 'public.bookings'::regclass`;
    if (trigger?.enabled !== "O") throw new Error("the bookings append-only trigger is not on");
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    app = createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
    });

    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "g212b-a", { days: 7 }),
      createCheckoutFixture(admin, runtime.db, "g212b-b", { days: 6 }),
    ]);
    A = await withAccess(a, "g212b-a");
    B = await withAccess(b, "g212b-b");
    await richTerms(A);
    const twoHats = `g212b-two-hats-${A.id.slice(0, 8)}@example.test`;
    await member(A.id, twoHats, "finance");
    await member(B.id, twoHats, "owner");
    const disabledOwner = await member(
      A.id,
      `g212b-a-disabled-${A.id.slice(0, 8)}@example.test`,
      "owner",
      "disabled",
    );

    const shared = (i: number) => at(A.trips.shared, i);
    const charters = (i: number) => at(A.trips.charter, i);

    const day0 = async () => {
      // One after another, so oldest first is rich, single, pair.
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
          {
            addOns: [
              { code: "snorkel", quantity: 3 },
              { code: "photo", quantity: 1 },
            ],
            promotionCode: A.promotionCode,
          },
        ),
        booker("ARich"),
      );
      const single = await book(A, await quote(A, shared(0), adults(1)), booker("ASingle"));
      const pair = await book(A, await quote(A, shared(0), adults(2)), booker("APair"));
      const charter = await book(A, await quote(A, charters(0), aboard(4)), booker("ACharter"));
      return { rich, single, pair, charter };
    };
    // Opened first, then every payment at once: confirmations at nearly one instant.
    const paidAtOnce = async (trips: { tripId: string; party: PartySelection; tag: string }[]) => {
      const opened = await Promise.all(
        trips.map(async (x) => open(A, await quote(A, x.tripId, x.party), booker(x.tag))),
      );
      await Promise.all(opened.map((o) => settle(A, o, "confirmed")));
      return Promise.all(opened.map(bookingOf));
    };
    const day1 = () =>
      paidAtOnce([
        ...Array.from({ length: 8 }, (_, i) => ({
          tripId: shared(1),
          party: adults(1),
          tag: `ACrowd${i}`,
        })),
        { tripId: charters(1), party: aboard(2), tag: "ACrowdCharter" },
      ]);
    const day2 = () =>
      paidAtOnce(
        Array.from({ length: 6 }, (_, i) => ({
          tripId: shared(2),
          party: adults(1),
          tag: `ATie${i}`,
        })),
      );
    // In this order, so the exceptions are newest first: mismatched, canceled, lost.
    const exceptions = async () => {
      const late = await open(A, await quote(A, shared(3), adults(2)), booker("AReacquired"));
      await backdateCheckout(admin, late.sessionId);
      await settle(A, late, "confirmed_reacquired");
      const reacquired = await bookingOf(late);
      const lost = await open(A, await quote(A, charters(3), aboard(2)), booker("ALost"));
      await backdateCheckout(admin, lost.sessionId);
      const taking = await open(A, await quote(A, charters(3), aboard(3)), booker("ATaker"));
      await settle(A, lost, "refund_required");
      await settle(A, taking, "confirmed");
      const taker = await bookingOf(taking);
      const canceled = await open(A, await quote(A, shared(4), adults(1)), booker("ACanceled"));
      await cancel(A, canceled);
      await settle(A, canceled, "refund_required");
      const mismatched = await open(A, await quote(A, shared(4), adults(2)), booker("AMismatch"));
      await deliver(A, mismatched, ["payment_mismatch"], { amount: mismatched.amount + 1 });
      return { reacquired, taker, lost, canceled, mismatched };
    };
    const tenantB = async () => {
      const bShared = at(B.trips.shared, 0);
      const bPair = await book(B, await quote(B, bShared, adults(2)), booker("BPair"));
      const bSingle = await book(B, await quote(B, bShared, adults(1)), booker("BSingle"));
      const bCanceled = await open(
        B,
        await quote(B, at(B.trips.shared, 1), adults(1)),
        booker("BCanceled"),
      );
      await cancel(B, bCanceled);
      await settle(B, bCanceled, "refund_required");
      // Two more paid after a cancel, whose refunds the provider refuses or
      // never answers. In this order, so B's newest exception is unanswered.
      const canceledThenPaid = async (tag: string, via: ReturnType<typeof createApp>) => {
        const o = await open(B, await quote(B, at(B.trips.shared, 1), adults(1)), booker(tag));
        await cancel(B, o);
        await deliver(B, o, ["refund_required"], { via });
        return o;
      };
      const bRefused = await canceledThenPaid("BRefused", appWhoseRefunds("are refused"));
      const bUnanswered = await canceledThenPaid("BUnanswered", appWhoseRefunds("go unanswered"));
      return { bPair, bSingle, bCanceled, bRefused, bUnanswered };
    };
    // Opened now and paid only by the last test. Holds last 15 minutes.
    const racing = () =>
      Promise.all(
        Array.from({ length: 8 }, async (_, i) =>
          open(A, await quote(A, shared(6), adults(1)), booker(`ARace${i}`)),
        ),
      );

    const [d0, crowd, ties, late, inB, race] = await Promise.all([
      day0(),
      day1(),
      day2(),
      exceptions(),
      tenantB(),
      racing(),
    ]);

    // Six confirmations rewritten to tie: three exactly, two more inside the
    // same millisecond, and one a millisecond later. Every new instant is
    // after the original, so each timeline keeps its order. Then one booking
    // in each tenant gets the same reference, with a 0 and a 1 in it.
    const tieIds = ties.map((t) => t.bookingId);
    await rewriteBookings(async (tx) => {
      const [base] = await tx<{ t: Date }[]>`
        select date_trunc('milliseconds', max(confirmed_at)) + interval '1 millisecond' as t
          from public.bookings where id in ${tx(tieIds)}`;
      if (!base) throw new Error("no base instant for the ties");
      for (const [i, id] of tieIds.entries()) {
        await tx`
          update public.bookings
             set confirmed_at = ${base.t}::timestamptz
                                + interval '1 microsecond' * ${TIE_OFFSETS[i] ?? 0}::int
           where id = ${id}`;
      }
      await tx`update public.bookings set reference = ${TWIN}
                where id in ${tx([d0.single.bookingId, inB.bPair.bookingId])}`;
    });

    fx = {
      day: {
        d0: await dateOf(shared(0)),
        d1: await dateOf(shared(1)),
        d2: await dateOf(shared(2)),
        d3: await dateOf(shared(3)),
        d4: await dateOf(shared(4)),
        d5: await dateOf(shared(5)),
      },
      raceDay: await dateOf(shared(6)),
      racing: race,
      bDay0: await dateOf(at(B.trips.shared, 0)),
      ...d0,
      single: { ...d0.single, reference: TWIN },
      crowd,
      ties,
      ...late,
      exceptionIds: {
        lost: await exceptionOf(late.lost),
        canceled: await exceptionOf(late.canceled),
        mismatched: await exceptionOf(late.mismatched),
      },
      bPair: { ...inB.bPair, reference: TWIN },
      bSingle: inB.bSingle,
      bCanceled: inB.bCanceled,
      bRefused: inB.bRefused,
      bUnanswered: inB.bUnanswered,
      bExceptionIds: {
        canceled: await exceptionOf(inB.bCanceled),
        refused: await exceptionOf(inB.bRefused),
        unanswered: await exceptionOf(inB.bUnanswered),
      },
      twoHats,
      disabledOwner,
    };
  }, 300_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  // Truth from the database, read as the admin role ----------------------------------------

  async function bookingTruth(id: string) {
    const [row] = await admin<
      {
        confirmed_at: Date;
        confirmed_us: string;
        checkout_created_at: Date;
        expires_at: Date;
        succeeded_at: Date;
        payment_created_at: Date;
        provider_payment_id: string;
      }[]
    >`
      select b.confirmed_at,
             to_char(b.confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as confirmed_us,
             s.created_at as checkout_created_at, s.expires_at,
             p.succeeded_at, p.created_at as payment_created_at, p.provider_payment_id
        from public.bookings b
        join public.checkout_sessions s on s.id = b.checkout_session_id
        join public.payments p on p.id = b.payment_id
       where b.id = ${id}`;
    if (!row) throw new Error(`no booking ${id}`);
    return row;
  }

  /** Each of a tenant's bookings on one local date: trip, departure, and confirmation in microseconds. */
  async function dayTruth(tenantId: string, date: string) {
    return admin<{ id: string; trip_id: string; starts_at: Date; confirmed_us: string }[]>`
      select b.id, b.trip_id, t.starts_at,
             to_char(b.confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as confirmed_us
        from public.bookings b
        join public.scheduled_trips t on t.id = b.trip_id
       where b.tenant_id = ${tenantId} and t.local_date = ${date}::date`;
  }

  /** Every page of a day's list, following nextAfter. */
  async function walk(
    tenant: Tenant,
    q: { date: string; tripId?: string },
    limit: number,
  ): Promise<BookingListResponse[]> {
    const pages: BookingListResponse[] = [];
    let after: string | undefined;
    for (let i = 0; i < 60; i++) {
      const res = await get(
        dayPath(tenant.id, { ...q, limit, ...(after === undefined ? {} : { after }) }),
        tenant.owner,
      );
      expect(res.status, res.text).toBe(200);
      const page = BookingListResponse.parse(res.json);
      pages.push(page);
      if (page.nextAfter === null) return pages;
      after = page.nextAfter;
    }
    throw new Error("the pages never ended");
  }

  /** Pages that are full until the last, each naming its own last id, and never empty at the end. */
  function expectWellFormedPages(pages: BookingListResponse[], limit: number) {
    const total = sum(pages.map((p) => p.bookings.length));
    for (const [i, page] of pages.entries()) {
      expect(page.trips).toEqual(pages[0]?.trips);
      if (i < pages.length - 1) {
        expect(page.bookings).toHaveLength(limit);
        expect(page.nextAfter).toBe(page.bookings.at(-1)?.id);
      } else {
        expect(page.bookings.length).toBeLessThanOrEqual(limit);
        if (total > 0) expect(page.bookings.length).toBeGreaterThan(0);
        expect(page.nextAfter).toBeNull();
      }
    }
  }

  /** Sorted by departure, and by confirmation within a trip, per the database's own precision. */
  function expectContractOrder(
    ids: readonly string[],
    truth: { id: string; trip_id: string; starts_at: Date; confirmed_us: string }[],
  ) {
    const byId = new Map(truth.map((t) => [t.id, t]));
    const rows = ids.map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error(`listed booking ${id} is not in the database's day`);
      return row;
    });
    const lastOnTrip = new Map<string, { id: string; confirmed_us: string }>();
    for (const [i, row] of rows.entries()) {
      const prev = rows[i - 1];
      if (prev) expect(prev.starts_at.getTime()).toBeLessThanOrEqual(row.starts_at.getTime());
      const last = lastOnTrip.get(row.trip_id);
      if (last)
        expect(last.confirmed_us <= row.confirmed_us, `${last.id} before ${row.id}`).toBe(true);
      lastOnTrip.set(row.trip_id, row);
    }
  }

  function expectMasked(masked: string | null | undefined, stored: string) {
    expect(masked).toMatch(MASKED);
    expect(masked?.slice(-4)).toBe(stored.slice(-4));
    expect(masked).not.toContain(stored.slice(5, -4));
  }

  const allA = () => [
    fx.rich,
    fx.single,
    fx.pair,
    fx.charter,
    ...fx.crowd,
    ...fx.ties,
    fx.reacquired,
    fx.taker,
  ];
  const madeById = (id: string): Made => {
    const found = [...allA(), fx.bPair, fx.bSingle].find((m) => m.bookingId === id);
    if (!found) throw new Error(`no fixture booking ${id}`);
    return found;
  };

  // A day's bookings ------------------------------------------------------------------------

  it("lists every trip of a day with counts that match its bookings, and only that day's", async () => {
    const shared0 = at(A.trips.shared, 0);
    const charter0 = at(A.trips.charter, 0);
    const late0 = at(A.trips.late, 0);
    const res = await get(dayPath(A.id, { date: fx.day.d0 }), A.owner);
    expect(res.status, res.text).toBe(200);
    const list = BookingListResponse.parse(res.json);
    expect(list.date).toBe(fx.day.d0);
    expect(list.nextAfter).toBeNull();

    // Every trip departing that day, booked or not, sorted by departure.
    const tripRows = await admin<{ id: string; sales_state: string }[]>`
      select id, sales_state from public.scheduled_trips
       where tenant_id = ${A.id} and local_date = ${fx.day.d0}::date`;
    expect(list.trips.map((t) => t.tripId).sort()).toEqual(tripRows.map((t) => t.id).sort());
    expect(list.trips.map((t) => t.tripId)).toEqual(
      expect.arrayContaining([shared0, charter0, late0]),
    );
    const departures = list.trips.map((t) => Date.parse(t.startsAt));
    expect(departures).toEqual([...departures].sort((x, y) => x - y));
    for (const trip of list.trips) {
      expect(trip.salesState).toBe(tripRows.find((r) => r.id === trip.tripId)?.sales_state);
      expect(trip.localDate).toBe(fx.day.d0);
    }

    // The counts are the bookings': as listed, and as stored.
    const counts = Object.fromEntries(
      list.trips.map((t) => [t.tripId, { bookings: t.bookings, guests: t.guests }]),
    );
    expect(counts).toEqual({
      [shared0]: { bookings: 3, guests: 6 },
      [charter0]: { bookings: 1, guests: 4 },
      [late0]: { bookings: 0, guests: 0 },
    });
    for (const trip of list.trips) {
      const own = list.bookings.filter((b) => b.tripId === trip.tripId);
      expect({ bookings: trip.bookings, guests: trip.guests }).toEqual({
        bookings: own.length,
        guests: sum(own.map((b) => b.party.guests)),
      });
    }
    const stored = await admin<{ trip_id: string; n: number; guests: number }[]>`
      select b.trip_id, count(*)::int as n, sum(b.party_size)::int as guests
        from public.bookings b join public.scheduled_trips t on t.id = b.trip_id
       where b.tenant_id = ${A.id} and t.local_date = ${fx.day.d0}::date
       group by b.trip_id`;
    for (const row of stored) {
      expect(counts[row.trip_id]).toEqual({ bookings: row.n, guests: row.guests });
    }

    // Exactly the day's bookings, each as it was made.
    const made = [fx.rich, fx.single, fx.pair, fx.charter];
    expect(list.bookings.map((b) => b.id).sort()).toEqual(made.map((m) => m.bookingId).sort());
    expect(list.bookings.filter((b) => b.tripId === shared0).map((b) => b.id)).toEqual([
      fx.rich.bookingId,
      fx.single.bookingId,
      fx.pair.bookingId,
    ]);
    expectContractOrder(
      list.bookings.map((b) => b.id),
      await dayTruth(A.id, fx.day.d0),
    );
    for (const m of made) {
      const item = list.bookings.find((b) => b.id === m.bookingId);
      expect(item).toMatchObject({
        reference: m.reference,
        tripId: m.tripId,
        state: "confirmed",
        source: "direct",
        confirmedAt: iso((await bookingTruth(m.bookingId)).confirmed_at),
        booker: { name: m.booker.name },
        total: m.quote.totals.total,
        currency: "USD",
        payment: { state: "succeeded", refund: null },
      });
      expect(item?.booker).toEqual({ name: m.booker.name });
    }
    expect(list.bookings.find((b) => b.id === fx.rich.bookingId)).toMatchObject({
      party: {
        kind: "tickets",
        guests: 3,
        tickets: [
          { code: "adult", name: "Adult", quantity: 2 },
          { code: "child", name: "Child 3 to 12", quantity: 1 },
        ],
      },
      extras: [
        { code: "snorkel", name: "Snorkel set", quantity: 3 },
        { code: "photo", name: "Souvenir photo", quantity: 1 },
      ],
    });
    expect(list.bookings.find((b) => b.id === fx.single.bookingId)).toMatchObject({
      party: { kind: "tickets", guests: 1, tickets: [{ code: "adult", quantity: 1 }] },
      extras: [],
    });

    // Another tenant's bookings on the same date never appear.
    const onB = await get(dayPath(A.id, { date: fx.bDay0 }), A.owner);
    const ids = BookingListResponse.parse(onB.json).bookings.map((b) => b.id);
    expect(ids).not.toContain(fx.bPair.bookingId);
    expect(ids).not.toContain(fx.bSingle.bookingId);
  });

  it("lists a day of unbooked trips with zero counts, a day without trips as empty, and filters by trip", async () => {
    const [quiet, none, oneTrip, otherDate, otherTenant] = await Promise.all([
      get(dayPath(A.id, { date: fx.day.d5 }), A.owner),
      get(dayPath(A.id, { date: "2099-12-31" }), A.owner),
      get(dayPath(A.id, { date: fx.day.d0, tripId: at(A.trips.charter, 0) }), A.owner),
      get(dayPath(A.id, { date: fx.day.d0, tripId: at(A.trips.shared, 1) }), A.owner),
      get(dayPath(A.id, { date: fx.day.d0, tripId: at(B.trips.shared, 0) }), A.owner),
    ]);
    const q = BookingListResponse.parse(quiet.json);
    expect(q.bookings).toEqual([]);
    expect(q.nextAfter).toBeNull();
    expect(q.trips.map((t) => t.tripId)).toEqual(
      expect.arrayContaining([at(A.trips.shared, 5), at(A.trips.charter, 5)]),
    );
    expect(q.trips.every((t) => t.bookings === 0 && t.guests === 0)).toBe(true);
    expect(BookingListResponse.parse(none.json)).toMatchObject({
      date: "2099-12-31",
      trips: [],
      bookings: [],
      nextAfter: null,
    });
    // A trip filter keeps every trip of the day in trips, and only its bookings in bookings.
    const one = BookingListResponse.parse(oneTrip.json);
    expect(one.bookings.map((b) => b.id)).toEqual([fx.charter.bookingId]);
    expect(one.trips).toHaveLength(3);
    // A trip on another date, or of another operator, matches nothing.
    for (const res of [otherDate, otherTenant]) {
      expect(res.status, res.text).toBe(200);
      const page = BookingListResponse.parse(res.json);
      expect(page.bookings).toEqual([]);
      expect(page.nextAfter).toBeNull();
      expect(page.trips.map((t) => t.tripId)).not.toContain(at(B.trips.shared, 0));
    }
  });

  it("pages a day without overlap or skip across bookings confirmed at nearly one instant", async () => {
    const full = BookingListResponse.parse(
      (await get(dayPath(A.id, { date: fx.day.d1, limit: 200 }), A.owner)).json,
    );
    const truth = await dayTruth(A.id, fx.day.d1);
    const order = full.bookings.map((b) => b.id);
    expect([...order].sort()).toEqual(truth.map((t) => t.id).sort());
    expect(order).toHaveLength(9);
    expect(new Set(order).size).toBe(9);
    expectContractOrder(order, truth);
    const crowdShared = truth.filter((t) => t.trip_id === at(A.trips.shared, 1));
    const spread = crowdShared.map((t) => t.confirmed_us).sort();
    console.log(
      `CONSOLE_STATS ${JSON.stringify({ case: "nearly_one_instant", bookings: crowdShared.length, first: spread[0], last: spread.at(-1) })}`,
    );

    // Each page size walked at once; the pages of one walk follow each other.
    const limits = [1, 2, 3, 4];
    const walks = await Promise.all(limits.map((limit) => walk(A, { date: fx.day.d1 }, limit)));
    for (const [i, pages] of walks.entries()) {
      expectWellFormedPages(pages, at(limits, i));
      expect(pages.flatMap((p) => p.bookings.map((b) => b.id))).toEqual(order);
      expect(pages.flatMap((p) => p.bookings)).toEqual(full.bookings);
    }
    // The same cursor returns the same page while nothing is booked in between.
    const cursor = order[3] ?? "";
    const [once, twice] = await Promise.all([
      get(dayPath(A.id, { date: fx.day.d1, limit: 2, after: cursor }), A.owner),
      get(dayPath(A.id, { date: fx.day.d1, limit: 2, after: cursor }), A.owner),
    ]);
    expect(once.json).toEqual(twice.json);
    expect(BookingListResponse.parse(once.json).bookings.map((b) => b.id)).toEqual(
      order.slice(4, 6),
    );
    // A trip filter pages the same way.
    const tripOnly = order.filter(
      (id) => full.bookings.find((b) => b.id === id)?.tripId === at(A.trips.shared, 1),
    );
    const filtered = await walk(A, { date: fx.day.d1, tripId: at(A.trips.shared, 1) }, 3);
    expectWellFormedPages(filtered, 3);
    expect(filtered.flatMap((p) => p.bookings.map((b) => b.id))).toEqual(tripOnly);
  });

  it("orders exact ties and same-millisecond confirmations the same way at every page size", async () => {
    const truth = await dayTruth(A.id, fx.day.d2);
    const stored = fx.ties.map((t) => truth.find((r) => r.id === t.bookingId)?.confirmed_us ?? "");
    // The rewrite took: three equal instants, two inside the same millisecond, one after it.
    expect(new Set(stored.slice(0, 3)).size).toBe(1);
    expect(stored[3]?.slice(0, 23)).toBe(stored[0]?.slice(0, 23));
    expect(stored[4]?.slice(0, 23)).toBe(stored[0]?.slice(0, 23));
    expect(stored[5]?.slice(0, 23)).not.toBe(stored[0]?.slice(0, 23));

    const full = BookingListResponse.parse(
      (await get(dayPath(A.id, { date: fx.day.d2 }), A.owner)).json,
    );
    const order = full.bookings.map((b) => b.id);
    expect([...order].sort()).toEqual(fx.ties.map((t) => t.bookingId).sort());
    expectContractOrder(order, truth);
    // By confirmation: the three tied first in some fixed order, then the rest by instant.
    expect(new Set(order.slice(0, 3))).toEqual(
      new Set(fx.ties.slice(0, 3).map((t) => t.bookingId)),
    );
    expect(order.slice(3)).toEqual(fx.ties.slice(3).map((t) => t.bookingId));
    // Five of the six read as the same millisecond; the pages still neither repeat nor skip.
    expect(new Set(full.bookings.slice(0, 5).map((b) => b.confirmedAt)).size).toBe(1);
    const limits = [1, 2, 4, 5];
    const walks = await Promise.all(limits.map((limit) => walk(A, { date: fx.day.d2 }, limit)));
    for (const [i, pages] of walks.entries()) {
      expectWellFormedPages(pages, at(limits, i));
      expect(pages.flatMap((p) => p.bookings.map((b) => b.id))).toEqual(order);
    }
    // Every cursor inside the tie, asked twice, names the one booking after it.
    const twice = await Promise.all(
      order
        .slice(0, 5)
        .flatMap((cursor) => [
          get(dayPath(A.id, { date: fx.day.d2, limit: 1, after: cursor }), A.owner),
          get(dayPath(A.id, { date: fx.day.d2, limit: 1, after: cursor }), A.owner),
        ]),
    );
    for (const [i, cursor] of order.slice(0, 5).entries()) {
      const first = at(twice, 2 * i);
      expect(first.json).toEqual(at(twice, 2 * i + 1).json);
      expect(BookingListResponse.parse(first.json).bookings.map((b) => b.id)).toEqual([
        order[order.indexOf(cursor) + 1],
      ]);
    }
    // The roster lists the same bookings oldest first.
    const roster = TripRosterResponse.parse(
      (await get(rosterPath(A.id, at(A.trips.shared, 2)), A.owner)).json,
    );
    const rosterIds = roster.roster.bookings.map((b) => b.id);
    expect([...rosterIds].sort()).toEqual([...order].sort());
    expectContractOrder(rosterIds, truth);
  });

  // Each role's view --------------------------------------------------------------------------

  it("gives owners, booking staff, and finance their view of every route, and finance never the booker", async () => {
    const shared0 = at(A.trips.shared, 0);
    const readAll = async (as: string) => {
      const [day, detail, reference, roster, exceptions] = await Promise.all([
        get(dayPath(A.id, { date: fx.day.d0 }), as),
        get(detailPath(A.id, fx.rich.bookingId), as),
        get(referencePath(A.id, fx.rich.reference), as),
        get(rosterPath(A.id, shared0), as),
        get(exceptionsPath(A.id), as),
      ]);
      return { day, detail, reference, roster, exceptions };
    };
    const owner = await readAll(A.owner);
    const staff = await readAll(A.staff);
    const finance = await readAll(A.finance);
    const statuses = (v: typeof owner) =>
      Object.fromEntries(Object.entries(v).map(([name, r]) => [name, r.status]));
    expect(statuses(owner)).toEqual({
      day: 200,
      detail: 200,
      reference: 200,
      roster: 200,
      exceptions: 200,
    });
    expect(statuses(staff)).toEqual(statuses(owner));
    expect(statuses(finance)).toEqual({
      day: 200,
      detail: 200,
      reference: 200,
      roster: 403,
      exceptions: 200,
    });
    expect(finance.roster.json.error?.code).toBe("forbidden");

    // Owners and booking staff get the booker: a name in lists, the email too in detail.
    const day = BookingListResponse.parse(owner.day.json);
    for (const b of day.bookings) expect(b.booker).toEqual({ name: madeById(b.id).booker.name });
    expect(BookingDetailResponse.parse(owner.detail.json).booking.booker).toEqual(fx.rich.booker);
    const roster = TripRosterResponse.parse(owner.roster.json);
    for (const b of roster.roster.bookings) {
      expect(b.booker).toEqual({ name: madeById(b.id).booker.name });
    }
    const exceptions = FinalizationExceptionsResponse.parse(owner.exceptions.json);
    const openedBy = new Map(
      [fx.lost, fx.canceled, fx.mismatched].map((o) => [o.sessionId, o.booker]),
    );
    expect(exceptions.exceptions).toHaveLength(3);
    for (const e of exceptions.exceptions)
      expect(e.booker).toEqual(openedBy.get(e.checkoutSessionId));
    // The reference lookup carries no personal data for anyone.
    expect(owner.reference.text).not.toContain('"booker"');

    // Finance: the field is absent, not blank, and no name or address is anywhere.
    for (const [name, res] of Object.entries(finance)) {
      if (name === "roster") continue;
      expect(res.text, name).not.toContain('"booker"');
      expect(res.text, name).not.toMatch(/Synthetic Booker|synthetic\.booker|example\.test/);
    }
    // Otherwise finance sees exactly what owners see, and booking staff see what owners see.
    expect(finance.day.json).toEqual(withoutKey(owner.day.json, "booker"));
    expect(finance.detail.json).toEqual(withoutKey(owner.detail.json, "booker"));
    expect(finance.reference.json).toEqual(owner.reference.json);
    expect(finance.exceptions.json).toEqual(withoutKey(owner.exceptions.json, "booker"));
    expect(staff.day.json).toEqual(owner.day.json);
    expect(staff.detail.json).toEqual(owner.detail.json);
    expect(staff.reference.json).toEqual(owner.reference.json);
    expect(staff.exceptions.json).toEqual(owner.exceptions.json);
    expect(withoutKey(staff.roster.json, "generatedAt")).toEqual(
      withoutKey(owner.roster.json, "generatedAt"),
    );
  });

  it("resolves the role per tenant for someone who is finance at one operator and owner at another", async () => {
    const [aDay, aDetail, aRoster, aExceptions, bDay, bDetail, bRoster] = await Promise.all([
      get(dayPath(A.id, { date: fx.day.d0 }), fx.twoHats),
      get(detailPath(A.id, fx.rich.bookingId), fx.twoHats),
      get(rosterPath(A.id, at(A.trips.shared, 0)), fx.twoHats),
      get(exceptionsPath(A.id), fx.twoHats),
      get(dayPath(B.id, { date: fx.bDay0 }), fx.twoHats),
      get(detailPath(B.id, fx.bPair.bookingId), fx.twoHats),
      get(rosterPath(B.id, at(B.trips.shared, 0)), fx.twoHats),
    ]);
    expect(
      [aDay, aDetail, aRoster, aExceptions, bDay, bDetail, bRoster].map((r) => r.status),
    ).toEqual([200, 200, 403, 200, 200, 200, 200]);
    for (const res of [aDay, aDetail, aExceptions]) {
      expect(res.text).not.toContain('"booker"');
      expect(res.text).not.toMatch(/Synthetic Booker|synthetic\.booker/);
    }
    expect(
      BookingListResponse.parse(bDay.json)
        .bookings.map((b) => b.booker?.name)
        .sort(),
    ).toEqual([fx.bPair.booker.name, fx.bSingle.booker.name].sort());
    expect(BookingDetailResponse.parse(bDetail.json).booking.booker).toEqual(fx.bPair.booker);
  });

  // One booking ----------------------------------------------------------------------------------

  it("shows a discounted booking's order lines and totals adding up to what the guest paid", async () => {
    const res = await get(detailPath(A.id, fx.rich.bookingId), A.owner);
    expect(res.status, res.text).toBe(200);
    const { booking } = BookingDetailResponse.parse(res.json);
    const truth = await bookingTruth(fx.rich.bookingId);
    const q = fx.rich.quote;
    expect(booking).toMatchObject({
      id: fx.rich.bookingId,
      reference: fx.rich.reference,
      state: "confirmed",
      source: "direct",
      reacquired: false,
      confirmedAt: iso(truth.confirmed_at),
      policyVersion: q.policy.version,
      party: {
        kind: "tickets",
        guests: 3,
        tickets: [
          { code: "adult", name: "Adult", quantity: 2 },
          { code: "child", name: "Child 3 to 12", quantity: 1 },
        ],
      },
      extras: [
        { code: "snorkel", name: "Snorkel set", quantity: 3 },
        { code: "photo", name: "Souvenir photo", quantity: 1 },
      ],
      refund: null,
    });
    // The trip and where to meet.
    const [where] = await admin<
      {
        starts_at: Date;
        ends_at: Date;
        sales_state: string;
        name: string;
        meeting_point: string;
        meeting_instructions: string;
      }[]
    >`
      select t.starts_at, t.ends_at, t.sales_state, l.name, l.meeting_point, l.meeting_instructions
        from public.scheduled_trips t
        join public.products p on p.id = t.product_id
        join public.locations l on l.id = p.location_id
       where t.id = ${fx.rich.tripId}`;
    expect(booking.trip).toMatchObject({
      tripId: fx.rich.tripId,
      productName: "Harbor Seats",
      productKind: "shared_seat",
      boatName: "Lark",
      timeZone: "UTC",
      localDate: fx.day.d0,
      localStartTime: "10:00",
      startsAt: iso(where?.starts_at ?? new Date(0)),
      endsAt: iso(where?.ends_at ?? new Date(0)),
      endsAtLocal: `${iso(where?.ends_at ?? new Date(0)).slice(0, 19)}+00:00`,
      durationMinutes: 60,
      salesState: where?.sales_state,
    });
    expect(Date.parse(booking.trip.endsAt) - Date.parse(booking.trip.startsAt)).toBe(60 * 60_000);
    expect(booking.location).toMatchObject({
      name: where?.name,
      meetingPoint: where?.meeting_point,
      meetingInstructions: where?.meeting_instructions,
    });

    // Every line, in order, and the totals they make.
    const { lines, totals } = booking.order;
    expect(booking.order).toMatchObject({ status: "paid", currency: "USD" });
    expect(lines.map((l) => l.lineNo)).toEqual(
      [...lines.map((l) => l.lineNo)].sort((x, y) => x - y),
    );
    expect(lines.map((l) => [l.kind, l.code])).toEqual([
      ["service", "adult"],
      ["service", "child"],
      ["add_on", "snorkel"],
      ["add_on", "photo"],
      ["fee", "port"],
      ["discount", A.promotionCode],
      ["tax", "tax"],
      ["tax", "tax"],
    ]);
    expect(lines.slice(0, 5)).toMatchObject([
      { quantity: 2, unitAmount: 5000, amount: 10000, basis: null, taxInclusive: null },
      { quantity: 1, unitAmount: 2500, amount: 2500, basis: null, taxInclusive: null },
      { quantity: 3, unitAmount: 1200, amount: 3600, basis: "per_participant" },
      { quantity: 1, unitAmount: 900, amount: 900, basis: "per_booking" },
      { quantity: 3, unitAmount: 250, amount: 750, basis: "per_participant" },
    ]);
    for (const line of lines.filter((l) => ["service", "add_on", "fee"].includes(l.kind))) {
      expect(line.amount).toBe(line.quantity * line.unitAmount);
    }
    const taxLines = lines.filter((l) => l.kind === "tax");
    expect(taxLines.every((l) => l.lineNo > 200)).toBe(true);
    expect(taxLines.map((l) => [l.taxInclusive, l.taxRatePpm]).sort()).toEqual([
      [false, 70_000],
      [true, 50_000],
    ]);
    const amountOf = (pick: (kind: string, inclusive: boolean | null) => boolean) =>
      sum(lines.filter((l) => pick(l.kind, l.taxInclusive)).map((l) => l.amount));
    expect(totals.subtotal).toBe(amountOf((k) => k === "service" || k === "add_on"));
    expect(totals.subtotal).toBe(17_000);
    expect(totals.discount).toBe(-amountOf((k) => k === "discount"));
    expect(totals.discount).toBe(1250);
    expect(totals.fees).toBe(amountOf((k) => k === "fee"));
    expect(totals.tax).toBe(amountOf((k, inc) => k === "tax" && inc === false));
    expect(totals.includedTax).toBe(amountOf((k, inc) => k === "tax" && inc === true));
    expect(totals.tax).toBeGreaterThan(0);
    expect(totals.includedTax).toBeGreaterThan(0);
    expect(totals.total).toBe(totals.subtotal - totals.discount + totals.fees + totals.tax);
    // What the guest was quoted is what the order says and what the payment took.
    expect(totals).toMatchObject({
      subtotal: q.totals.subtotal,
      discount: q.totals.discount,
      fees: q.totals.fees,
      tax: q.totals.tax,
      includedTax: q.totals.includedTax,
      total: q.totals.total,
    });
    for (const ql of q.lines) {
      expect(lines.find((l) => l.lineNo === ql.lineNo)).toMatchObject({
        code: ql.code,
        quantity: ql.quantity,
        unitAmount: ql.unitAmount,
        amount: ql.amount,
      });
    }
    expect(booking.payment).toMatchObject({
      provider: "fake",
      state: "succeeded",
      amount: totals.total,
      currency: "USD",
      createdAt: iso(truth.payment_created_at),
      succeededAt: iso(truth.succeeded_at),
    });
    expect(fx.rich.amount).toBe(totals.total);
    expectMasked(booking.payment.providerReference, truth.provider_payment_id);
    expect(res.text).not.toContain(truth.provider_payment_id);
    // Checkout opened, paid, confirmed: oldest first, from the stored instants.
    expect(booking.timeline).toMatchObject([
      { kind: "checkout_opened", at: iso(truth.checkout_created_at) },
      { kind: "paid", at: iso(truth.succeeded_at) },
      { kind: "confirmed", at: iso(truth.confirmed_at) },
    ]);
  });

  it("reads a charter's party as the charter and its guests in the list, the detail, and the roster", async () => {
    const charter0 = at(A.trips.charter, 0);
    const [listRes, detailRes, rosterRes] = await Promise.all([
      get(dayPath(A.id, { date: fx.day.d0, tripId: charter0 }), A.owner),
      get(detailPath(A.id, fx.charter.bookingId), A.owner),
      get(rosterPath(A.id, charter0), A.owner),
    ]);
    const party = { kind: "charter", guests: 4, charter: "Whole boat" };
    const item = BookingListResponse.parse(listRes.json).bookings[0];
    expect(item).toMatchObject({ id: fx.charter.bookingId, party, extras: [] });
    const { booking } = BookingDetailResponse.parse(detailRes.json);
    expect(booking).toMatchObject({
      party,
      extras: [],
      trip: { productKind: "private_charter", boatName: "Wren", durationMinutes: 120 },
    });
    const service = booking.order.lines.filter((l) => l.kind === "service");
    expect(service).toMatchObject([
      { code: "charter", name: "Whole boat", quantity: 1, unitAmount: 100_000 },
    ]);
    const { roster } = TripRosterResponse.parse(rosterRes.json);
    const [seats] = await admin<{ n: number }[]>`
      select seat_capacity as n from public.scheduled_trips where id = ${charter0}`;
    expect(roster.trip.seats).toBe(seats?.n);
    expect(roster.totals).toMatchObject({ bookings: 1, guests: 4, tickets: [], extras: [] });
    expect(roster.bookings).toMatchObject([{ id: fx.charter.bookingId, party }]);
  });

  it("shows a booking paid after its hold lapsed as reacquired, with its timeline", async () => {
    const res = await get(detailPath(A.id, fx.reacquired.bookingId), A.owner);
    const { booking } = BookingDetailResponse.parse(res.json);
    const truth = await bookingTruth(fx.reacquired.bookingId);
    expect(booking).toMatchObject({ reacquired: true, refund: null, order: { status: "paid" } });
    expect(Date.parse(booking.confirmedAt)).toBeGreaterThan(truth.expires_at.getTime());
    expect(booking.timeline.map((e) => e.kind)).toEqual(["checkout_opened", "paid", "confirmed"]);
    const instants = booking.timeline.map((e) => Date.parse(e.at));
    expect(instants).toEqual([...instants].sort((x, y) => x - y));
    // The booking that took the boat from a lapsed checkout was not reacquired.
    const taker = BookingDetailResponse.parse(
      (await get(detailPath(A.id, fx.taker.bookingId), A.owner)).json,
    );
    expect(taker.booking).toMatchObject({
      reacquired: false,
      party: { kind: "charter", guests: 3 },
    });
  });

  // Lookup by reference ----------------------------------------------------------------------------

  it("finds a booking by its reference as people type it, within each tenant, and nothing else", async () => {
    const r = fx.rich.reference;
    const richForms = [
      r,
      r.toLowerCase(),
      `${r.slice(0, 4)}-${r.slice(4)}`,
      ` ${r.slice(0, 4)} ${r.slice(4)} `,
    ];
    // TWIN is Q0Q1ZZ10: O reads as 0, and I and L read as 1.
    const twinForms = [
      "Q0Q1ZZ10",
      "q0q1zz10",
      "QOQIZZLO",
      "qoql-zzio",
      "Q O Q I-Z Z L O",
      "q0Q1-zZ1o",
    ];
    const [richAnswers, twinAtA, twinAtB, twinAsFinance] = await Promise.all([
      Promise.all(richForms.map((f) => get(referencePath(A.id, f), A.owner))),
      Promise.all(twinForms.map((f) => get(referencePath(A.id, f), A.staff))),
      Promise.all(twinForms.map((f) => get(referencePath(B.id, f), B.owner))),
      Promise.all(twinForms.map((f) => get(referencePath(A.id, f), A.finance))),
    ]);
    for (const res of richAnswers) {
      expect(res.status, res.text).toBe(200);
      expect(BookingReferenceResponse.parse(res.json).booking).toMatchObject({
        id: fx.rich.bookingId,
        reference: r,
        tripId: fx.rich.tripId,
        localDate: fx.day.d0,
      });
    }
    // The same reference in two tenants: each finds its own, never the other's.
    for (const res of [...twinAtA, ...twinAsFinance]) {
      expect(res.status, res.text).toBe(200);
      expect(BookingReferenceResponse.parse(res.json).booking).toMatchObject({
        id: fx.single.bookingId,
        reference: TWIN,
        tripId: fx.single.tripId,
      });
    }
    for (const res of twinAtB) {
      expect(res.status, res.text).toBe(200);
      expect(BookingReferenceResponse.parse(res.json).booking).toMatchObject({
        id: fx.bPair.bookingId,
        reference: TWIN,
        tripId: fx.bPair.tripId,
      });
    }

    // Anything that cannot be a reference, and an unknown one, share one 404.
    const refused = await Promise.all(
      [
        "Q0Q1ZZ1U",
        "Q0Q1ZZ1",
        "Q0Q1ZZ100",
        "Q0Q1_ZZ10",
        "Q".repeat(65),
        "'; select 1 --",
        "../bookings",
        "ZZZZZZZZ",
      ].map((f) => get(referencePath(A.id, f), A.owner)),
    );
    for (const res of refused) {
      expect(answer(res)).toEqual(refusal(404, "booking_not_found"));
      expect(answer(res)).toEqual(answer(at(refused, 0)));
    }
  });

  // A trip's roster ---------------------------------------------------------------------------------

  it("sums a trip's roster from its bookings, oldest first, and lists an unbooked trip as empty", async () => {
    const shared0 = at(A.trips.shared, 0);
    const [res, list, quiet] = await Promise.all([
      get(rosterPath(A.id, shared0), A.owner),
      get(dayPath(A.id, { date: fx.day.d0, tripId: shared0 }), A.owner),
      get(rosterPath(A.id, at(A.trips.shared, 5)), A.staff),
    ]);
    expect(res.status, res.text).toBe(200);
    const { roster } = TripRosterResponse.parse(res.json);
    const [trip] = await admin<{ seat_capacity: number; starts_at: Date }[]>`
      select seat_capacity, starts_at from public.scheduled_trips where id = ${shared0}`;
    expect(roster.trip).toMatchObject({
      tripId: shared0,
      productKind: "shared_seat",
      seats: trip?.seat_capacity,
      startsAt: iso(trip?.starts_at ?? new Date(0)),
      localDate: fx.day.d0,
    });
    expect(Math.abs(Date.parse(roster.generatedAt) - Date.now())).toBeLessThan(5 * 60_000);
    expect(roster.bookings.map((b) => b.id)).toEqual([
      fx.rich.bookingId,
      fx.single.bookingId,
      fx.pair.bookingId,
    ]);
    for (const b of roster.bookings) {
      const m = madeById(b.id);
      expect(b).toMatchObject({
        reference: m.reference,
        booker: { name: m.booker.name },
        payment: { state: "succeeded", refund: null },
      });
    }
    // Totals: as made, and as the sum of the roster's own bookings.
    const byCode = <T extends { code: string }>(xs: T[]) =>
      [...xs].sort((x, y) => x.code.localeCompare(y.code));
    expect(roster.totals.bookings).toBe(3);
    expect(roster.totals.guests).toBe(6);
    expect(byCode(roster.totals.tickets)).toMatchObject([
      { code: "adult", name: "Adult", quantity: 5 },
      { code: "child", name: "Child 3 to 12", quantity: 1 },
    ]);
    expect(byCode(roster.totals.extras)).toMatchObject([
      { code: "photo", name: "Souvenir photo", quantity: 1 },
      { code: "snorkel", name: "Snorkel set", quantity: 3 },
    ]);
    expect(roster.totals.bookings).toBe(roster.bookings.length);
    expect(roster.totals.guests).toBe(sum(roster.bookings.map((b) => b.party.guests)));
    const summed = new Map<string, number>();
    for (const b of roster.bookings) {
      if (b.party.kind !== "tickets") continue;
      for (const t of b.party.tickets) summed.set(t.code, (summed.get(t.code) ?? 0) + t.quantity);
    }
    expect(Object.fromEntries(roster.totals.tickets.map((t) => [t.code, t.quantity]))).toEqual(
      Object.fromEntries(summed),
    );
    const extras = new Map<string, number>();
    for (const b of roster.bookings) {
      for (const e of b.extras) extras.set(e.code, (extras.get(e.code) ?? 0) + e.quantity);
    }
    expect(Object.fromEntries(roster.totals.extras.map((e) => [e.code, e.quantity]))).toEqual(
      Object.fromEntries(extras),
    );
    // The roster and the day list agree on the trip.
    const day = BookingListResponse.parse(list.json);
    expect([...roster.bookings.map((b) => b.id)].sort()).toEqual(
      [...day.bookings.map((b) => b.id)].sort(),
    );
    expect(day.trips.find((t) => t.tripId === shared0)).toMatchObject({
      bookings: roster.totals.bookings,
      guests: roster.totals.guests,
    });
    // A trip nobody booked.
    expect(quiet.status, quiet.text).toBe(200);
    expect(TripRosterResponse.parse(quiet.json).roster).toMatchObject({
      totals: { bookings: 0, guests: 0, tickets: [], extras: [] },
      bookings: [],
    });
  });

  // Finalization exceptions ---------------------------------------------------------------------------

  it("lists payments that could not become bookings, newest first, with what it takes to follow up", async () => {
    const [ownerRes, financeRes] = await Promise.all([
      get(exceptionsPath(A.id), A.owner),
      get(exceptionsPath(A.id), A.finance),
    ]);
    expect(ownerRes.status, ownerRes.text).toBe(200);
    const page = FinalizationExceptionsResponse.parse(ownerRes.json);
    expect(page.nextBefore).toBeNull();
    expect(page.exceptions.map((e) => e.id)).toEqual([
      fx.exceptionIds.mismatched,
      fx.exceptionIds.canceled,
      fx.exceptionIds.lost,
    ]);
    const truth = await admin<
      {
        id: string;
        created_at: Date;
        refund_id: string | null;
        verified_at: Date;
        expires_at: Date;
        provider_payment_id: string;
      }[]
    >`
      select e.id, e.created_at, e.refund_id, ev.verified_at, s.expires_at, p.provider_payment_id
        from public.finalization_exceptions e
        join public.provider_events ev on ev.id = e.provider_event_id
        join public.checkout_sessions s on s.id = e.checkout_session_id
        join public.payments p on p.id = e.payment_id
       where e.tenant_id = ${A.id}`;
    const row = (id: string) => {
      const found = truth.find((t) => t.id === id);
      if (!found) throw new Error(`no exception ${id}`);
      return found;
    };
    const byId = (id: string) => page.exceptions.find((e) => e.id === id);
    const expected = [
      {
        o: fx.lost,
        id: fx.exceptionIds.lost,
        reason: "no_capacity",
        state: "unfulfilled",
        trip: at(A.trips.charter, 3),
        kind: "private_charter",
        date: fx.day.d3,
        party: 2,
        reported: fx.lost.amount,
        refunded: true,
      },
      {
        o: fx.canceled,
        id: fx.exceptionIds.canceled,
        reason: "session_canceled",
        state: "unfulfilled",
        trip: at(A.trips.shared, 4),
        kind: "shared_seat",
        date: fx.day.d4,
        party: 1,
        reported: fx.canceled.amount,
        refunded: true,
      },
      {
        o: fx.mismatched,
        id: fx.exceptionIds.mismatched,
        reason: "payment_mismatch",
        state: "open",
        trip: at(A.trips.shared, 4),
        kind: "shared_seat",
        date: fx.day.d4,
        party: 2,
        reported: fx.mismatched.amount + 1,
        refunded: false,
      },
    ];
    for (const x of expected) {
      const e = byId(x.id);
      const stored = row(x.id);
      expect(e).toMatchObject({
        reason: x.reason,
        checkoutSessionId: x.o.sessionId,
        tripId: x.trip,
        paymentId: x.o.paymentId,
        amount: x.o.amount,
        createdAt: iso(stored.created_at),
        trip: { tripId: x.trip, productKind: x.kind, localDate: x.date },
        partySize: x.party,
        checkout: { state: x.state, expiresAt: iso(stored.expires_at) },
        payment: {
          provider: "fake",
          receivedAt: iso(stored.verified_at),
          reportedAmount: x.reported,
          reportedCurrency: "USD",
        },
        booker: x.o.booker,
      });
      expectMasked(e?.payment.providerReference, stored.provider_payment_id);
      if (x.refunded) {
        expect(e?.refund).toMatchObject({
          id: stored.refund_id,
          state: "succeeded",
          amount: x.o.amount,
          failureCode: null,
        });
        expect(e?.refund?.settledAt).not.toBeNull();
      } else {
        expect(e?.refund).toBeNull();
      }
    }
    const created = page.exceptions.map((e) => Date.parse(e.createdAt));
    expect(created).toEqual([...created].sort((x, y) => y - x));
    // B's exceptions are B's alone.
    for (const id of Object.values(fx.bExceptionIds)) {
      expect(page.exceptions.map((e) => e.id)).not.toContain(id);
    }
    // Finance follows the same list without the booker.
    expect(financeRes.json).toEqual(withoutKey(ownerRes.json, "booker"));
    expect(financeRes.text).not.toMatch(/"booker"|Synthetic Booker|synthetic\.booker/);
  });

  it("pages the exceptions with before, without overlap or skip, and repeats a page for its cursor", async () => {
    const order = [fx.exceptionIds.mismatched, fx.exceptionIds.canceled, fx.exceptionIds.lost];
    // Limit 3 is exactly the count: one full page, then nothing more.
    const walkExceptions = async (limit: number) => {
      const seen: string[] = [];
      let before: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await get(
          exceptionsPath(A.id, { limit, ...(before === undefined ? {} : { before }) }),
          A.finance,
        );
        expect(res.status, res.text).toBe(200);
        const page = FinalizationExceptionsResponse.parse(res.json);
        seen.push(...page.exceptions.map((e) => e.id));
        if (page.nextBefore === null) {
          expect(page.exceptions.length).toBeGreaterThan(0);
          return seen;
        }
        expect(page.exceptions).toHaveLength(limit);
        expect(page.nextBefore).toBe(page.exceptions.at(-1)?.id);
        before = page.nextBefore;
      }
      throw new Error("the exception pages never ended");
    };
    expect(await Promise.all([1, 2, 3].map(walkExceptions))).toEqual([order, order, order]);
    const [once, twice] = await Promise.all([
      get(exceptionsPath(A.id, { limit: 1, before: fx.exceptionIds.mismatched }), A.owner),
      get(exceptionsPath(A.id, { limit: 1, before: fx.exceptionIds.mismatched }), A.owner),
    ]);
    expect(once.json).toEqual(twice.json);
    expect(FinalizationExceptionsResponse.parse(once.json)).toMatchObject({
      exceptions: [{ id: fx.exceptionIds.canceled }],
      nextBefore: fx.exceptionIds.canceled,
    });
  });

  it("shows a refund the provider refused and one it never answered, for follow-up", async () => {
    const [ownerRes, financeRes] = await Promise.all([
      get(exceptionsPath(B.id), B.owner),
      get(exceptionsPath(B.id), B.finance),
    ]);
    expect(ownerRes.status, ownerRes.text).toBe(200);
    const page = FinalizationExceptionsResponse.parse(ownerRes.json);
    const ids = fx.bExceptionIds;
    expect(page.exceptions.map((e) => e.id)).toEqual([ids.unanswered, ids.refused, ids.canceled]);
    const refunds = await admin<
      { id: string; state: string; failure_code: string | null; settled_at: Date | null }[]
    >`
      select e.id, r.state, r.failure_code, r.settled_at
        from public.finalization_exceptions e
        join public.payment_refunds r on r.id = e.refund_id
       where e.tenant_id = ${B.id}`;
    const stored = (id: string) => refunds.find((r) => r.id === id);
    const byId = (id: string) => page.exceptions.find((e) => e.id === id);
    expect(byId(ids.refused)).toMatchObject({
      reason: "session_canceled",
      checkoutSessionId: fx.bRefused.sessionId,
      amount: fx.bRefused.amount,
      checkout: { state: "unfulfilled" },
      refund: { state: "failed", amount: fx.bRefused.amount, failureCode: "insufficient_funds" },
      booker: fx.bRefused.booker,
    });
    expect(byId(ids.refused)?.refund?.settledAt).toBe(
      iso(stored(ids.refused)?.settled_at ?? new Date(0)),
    );
    expect(byId(ids.unanswered)).toMatchObject({
      reason: "session_canceled",
      checkoutSessionId: fx.bUnanswered.sessionId,
      refund: {
        state: "requested",
        amount: fx.bUnanswered.amount,
        failureCode: null,
        settledAt: null,
      },
    });
    expect(stored(ids.unanswered)).toMatchObject({ state: "requested", settled_at: null });
    expect(byId(ids.canceled)).toMatchObject({ refund: { state: "succeeded", failureCode: null } });
    // Finance follows up on the same refunds without the booker.
    expect(financeRes.json).toEqual(withoutKey(ownerRes.json, "booker"));
    expect(financeRes.text).not.toMatch(/"booker"|Synthetic Booker|synthetic\.booker/);
  });

  // Two tenants -------------------------------------------------------------------------------------------

  it("answers another tenant's booking, reference, trip, and cursors exactly as unknown ones", async () => {
    const unknown = randomUUID();
    const shared0 = at(A.trips.shared, 0);
    const checks: [string, Promise<Res>][] = [];
    for (const [who, as] of [
      ["owner", B.owner],
      ["finance", B.finance],
    ] as const) {
      checks.push(
        [`${who}: A's booking`, get(detailPath(B.id, fx.rich.bookingId), as)],
        [`${who}: unknown booking`, get(detailPath(B.id, unknown), as)],
        [`${who}: malformed booking`, get(detailPath(B.id, "not-a-booking"), as)],
        [`${who}: injected booking`, get(detailPath(B.id, "' or '1'='1"), as)],
        [`${who}: A's reference`, get(referencePath(B.id, fx.rich.reference), as)],
        [`${who}: unknown reference`, get(referencePath(B.id, "ZZZZZZZZ"), as)],
        [`${who}: junk reference`, get(referencePath(B.id, "not a reference"), as)],
        [
          `${who}: A's booking as after`,
          get(dayPath(B.id, { date: fx.day.d0, after: fx.rich.bookingId }), as),
        ],
        [`${who}: unknown after`, get(dayPath(B.id, { date: fx.day.d0, after: unknown }), as)],
        [
          `${who}: A's exception as before`,
          get(exceptionsPath(B.id, { before: fx.exceptionIds.lost }), as),
        ],
        [`${who}: unknown before`, get(exceptionsPath(B.id, { before: unknown }), as)],
      );
    }
    checks.push(
      ["owner: A's trip", get(rosterPath(B.id, shared0), B.owner)],
      ["owner: unknown trip", get(rosterPath(B.id, unknown), B.owner)],
      ["owner: malformed trip", get(rosterPath(B.id, "trip"), B.owner)],
      ["staff: A's trip", get(rosterPath(B.id, shared0), B.staff)],
      // And the other way round: B's things at A's address, by A's staff.
      ["A owner: B's booking", get(detailPath(A.id, fx.bPair.bookingId), A.owner)],
      ["A owner: unknown booking", get(detailPath(A.id, unknown), A.owner)],
      ["A owner: B's trip", get(rosterPath(A.id, at(B.trips.shared, 0)), A.owner)],
      [
        "A owner: B's booking as after",
        get(dayPath(A.id, { date: fx.day.d0, after: fx.bPair.bookingId }), A.owner),
      ],
      [
        "A owner: B's exception as before",
        get(exceptionsPath(A.id, { before: fx.bExceptionIds.canceled }), A.owner),
      ],
      ["A owner: B's reference", get(referencePath(A.id, fx.bSingle.reference), A.owner)],
    );
    const settled = await Promise.all(checks.map(async ([name, p]) => [name, await p] as const));
    const got = Object.fromEntries(settled.map(([name, res]) => [name, answer(res)]));
    const notFound = refusal(404, "booking_not_found");
    const noTrip = refusal(404, "trip_not_found");
    const badCursor = refusal(400, "cursor_invalid");
    const want: Record<string, unknown> = {};
    for (const who of ["owner", "finance"]) {
      Object.assign(want, {
        [`${who}: A's booking`]: notFound,
        [`${who}: unknown booking`]: notFound,
        [`${who}: malformed booking`]: notFound,
        [`${who}: injected booking`]: notFound,
        [`${who}: A's reference`]: notFound,
        [`${who}: unknown reference`]: notFound,
        [`${who}: junk reference`]: notFound,
        [`${who}: A's booking as after`]: badCursor,
        [`${who}: unknown after`]: badCursor,
        [`${who}: A's exception as before`]: badCursor,
        [`${who}: unknown before`]: badCursor,
      });
    }
    Object.assign(want, {
      "owner: A's trip": noTrip,
      "owner: unknown trip": noTrip,
      "owner: malformed trip": noTrip,
      "staff: A's trip": noTrip,
      "A owner: B's booking": notFound,
      "A owner: unknown booking": notFound,
      "A owner: B's trip": noTrip,
      "A owner: B's booking as after": badCursor,
      "A owner: B's exception as before": badCursor,
      "A owner: B's reference": notFound,
    });
    expect(got).toEqual(want);
    // Not merely the same code: the same body, byte for byte apart from the request id.
    const same = (x: string, y: string) => expect(got[x], `${x} vs ${y}`).toEqual(got[y]);
    same("owner: A's booking", "owner: unknown booking");
    same("owner: A's booking", "owner: malformed booking");
    same("owner: A's reference", "owner: unknown reference");
    same("owner: A's reference", "owner: junk reference");
    same("owner: A's booking as after", "owner: unknown after");
    same("owner: A's exception as before", "owner: unknown before");
    same("owner: A's trip", "owner: unknown trip");
    same("owner: A's trip", "owner: malformed trip");
    same("A owner: B's booking", "A owner: unknown booking");

    // B's lists, filtered by A's trip or not, carry nothing of A's.
    const [bDay, bFiltered, bExceptions] = await Promise.all([
      get(dayPath(B.id, { date: fx.day.d0 }), B.owner),
      get(dayPath(B.id, { date: fx.day.d0, tripId: shared0 }), B.owner),
      get(exceptionsPath(B.id), B.owner),
    ]);
    const aIds = [...allA().map((m) => m.bookingId), ...allA().map((m) => m.sessionId), shared0];
    for (const res of [bDay, bFiltered, bExceptions]) {
      expect(res.status, res.text).toBe(200);
      for (const id of [...aIds, ...Object.values(fx.exceptionIds)]) {
        expect(res.text).not.toContain(id);
      }
      expect(res.text).not.toMatch(/Synthetic Booker A|synthetic\.booker\.a/);
    }
    expect(BookingListResponse.parse(bFiltered.json).bookings).toEqual([]);
    expect(
      FinalizationExceptionsResponse.parse(bExceptions.json).exceptions.map((e) => e.id),
    ).toEqual([fx.bExceptionIds.unanswered, fx.bExceptionIds.refused, fx.bExceptionIds.canceled]);
  });

  it("answers staff of another tenant, a disabled member, and an unknown tenant with one 404 on every route", async () => {
    const routes = (
      tenantId: string,
      ids: { booking: string; reference: string; trip: string },
    ) => ({
      day: dayPath(tenantId, { date: fx.day.d0 }),
      detail: detailPath(tenantId, ids.booking),
      reference: referencePath(tenantId, ids.reference),
      roster: rosterPath(tenantId, ids.trip),
      exceptions: exceptionsPath(tenantId),
    });
    const aIds = {
      booking: fx.rich.bookingId,
      reference: fx.rich.reference,
      trip: at(A.trips.shared, 0),
    };
    const bIds = {
      booking: fx.bPair.bookingId,
      reference: fx.bSingle.reference,
      trip: at(B.trips.shared, 0),
    };
    const callers: [string, string, string, typeof aIds][] = [
      ["B's owner at A", A.id, B.owner, aIds],
      ["B's booking staff at A", A.id, B.staff, aIds],
      ["B's finance at A", A.id, B.finance, aIds],
      ["B's owner at A with B's ids", A.id, B.owner, bIds],
      ["A's owner at B", B.id, A.owner, bIds],
      ["A's finance at B", B.id, A.finance, bIds],
      ["A's disabled owner at A", A.id, fx.disabledOwner, aIds],
      ["A's owner at an unknown tenant", randomUUID(), A.owner, aIds],
      ["A's owner at a malformed tenant", "not-a-tenant", A.owner, aIds],
    ];
    const results = await Promise.all(
      callers.flatMap(([name, tenantId, as, ids]) =>
        Object.entries(routes(tenantId, ids)).map(async ([route, path]) => [
          `${name}: ${route}`,
          answer(await get(path, as)),
        ]),
      ),
    );
    const got = Object.fromEntries(results);
    const want = Object.fromEntries(
      results.map(([name]) => [name, refusal(404, "tenant_not_found")]),
    );
    expect(got).toEqual(want);
    const bodies = new Set(results.map(([, a]) => JSON.stringify(a)));
    expect(bodies.size).toBe(1);

    // Signed out: 401 on every route, before any tenant is looked at.
    const signedOut = await Promise.all(
      Object.entries(routes(A.id, aIds)).map(async ([route, path]) => [
        route,
        answer(await get(path)),
      ]),
    );
    expect(Object.fromEntries(signedOut)).toEqual(
      Object.fromEntries(signedOut.map(([route]) => [route, refusal(401, "unauthenticated")])),
    );
  });

  // Secrets and headers -------------------------------------------------------------------------------------

  it("returns no checkout secret, key, hash, client secret, or full provider id in any response", async () => {
    const tenants = [A.id, B.id];
    const opened = [
      ...allA(),
      fx.lost,
      fx.canceled,
      fx.mismatched,
      fx.bPair,
      fx.bSingle,
      fx.bCanceled,
      fx.bRefused,
      fx.bUnanswered,
      ...fx.racing,
    ];
    const forbidden: [string, string][] = [];
    for (const o of opened) {
      forbidden.push(
        ["checkout secret", o.secret],
        ["checkout idempotency key", o.key],
        ["fake client secret", o.clientSecret],
        ["fake client secret tail", o.clientSecret.split("_secret_")[1] ?? o.clientSecret],
      );
    }
    for (const row of await admin<{ secret_hash: string; client_key: string | null }[]>`
      select secret_hash, client_key from public.checkout_sessions where tenant_id in ${admin(tenants)}`) {
      forbidden.push(["checkout secret hash", row.secret_hash]);
      if (row.client_key) forbidden.push(["checkout client key", row.client_key]);
    }
    for (const row of await admin<
      { idempotency_key: string; provider_payment_id: string | null }[]
    >`
      select idempotency_key, provider_payment_id from public.payments where tenant_id in ${admin(tenants)}`) {
      forbidden.push(["payment idempotency key", row.idempotency_key]);
      if (row.provider_payment_id) {
        forbidden.push(
          ["provider payment id", row.provider_payment_id],
          ["provider payment id body", row.provider_payment_id.slice(5, -4)],
        );
      }
    }
    for (const row of await admin<{ idempotency_key: string; provider_refund_id: string | null }[]>`
      select idempotency_key, provider_refund_id from public.payment_refunds where tenant_id in ${admin(tenants)}`) {
      forbidden.push(["refund idempotency key", row.idempotency_key]);
      if (row.provider_refund_id) forbidden.push(["provider refund id", row.provider_refund_id]);
    }
    for (const row of await admin<{ payload_sha256: string; event_id: string }[]>`
      select payload_sha256, event_id from public.provider_events where tenant_id in ${admin(tenants)}`) {
      forbidden.push(
        ["event payload hash", row.payload_sha256],
        ["provider event id", row.event_id],
      );
    }
    // Every booking and trip in detail, every day and list, as owners and as finance.
    const paths: [string, string, string][] = [];
    for (const m of allA()) {
      paths.push([`detail ${m.bookingId}`, detailPath(A.id, m.bookingId), A.owner]);
      paths.push([`reference ${m.reference}`, referencePath(A.id, m.reference), A.owner]);
    }
    for (const tripId of new Set(allA().map((m) => m.tripId))) {
      paths.push([`roster ${tripId}`, rosterPath(A.id, tripId), A.owner]);
    }
    for (const [name, date] of Object.entries(fx.day)) {
      paths.push([`day ${name}`, dayPath(A.id, { date }), A.owner]);
      paths.push([`finance day ${name}`, dayPath(A.id, { date }), A.finance]);
    }
    paths.push(
      ["finance detail", detailPath(A.id, fx.rich.bookingId), A.finance],
      ["exceptions", exceptionsPath(A.id), A.owner],
      ["finance exceptions", exceptionsPath(A.id), A.finance],
      ["B detail", detailPath(B.id, fx.bPair.bookingId), B.owner],
      ["B day", dayPath(B.id, { date: fx.bDay0 }), B.owner],
      ["B exceptions", exceptionsPath(B.id), B.owner],
    );
    const responses = await Promise.all(
      paths.map(async ([name, path, as]) => [name, await get(path, as)] as const),
    );
    for (const [name, res] of responses) expect(res.status, `${name}: ${res.text}`).toBe(200);
    // Report what leaked where, never the value itself.
    const leaks: string[] = [];
    for (const [name, res] of responses) {
      for (const [label, value] of forbidden) {
        if (value.length >= 8 && res.text.includes(value)) leaks.push(`${label} in ${name}`);
      }
      for (const key of keysOf(res.json)) {
        if (/secret|hash|idempoten|payload|clientkey|client_key/i.test(key)) {
          leaks.push(`field ${key} in ${name}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(forbidden.length).toBeGreaterThan(100);
  });

  it("answers every route's success with Cache-Control: no-store", async () => {
    const responses = await Promise.all([
      get(dayPath(A.id, { date: fx.day.d0 }), A.owner),
      get(dayPath(A.id, { date: fx.day.d0 }), A.finance),
      get(detailPath(A.id, fx.rich.bookingId), A.owner),
      get(detailPath(A.id, fx.rich.bookingId), A.finance),
      get(referencePath(A.id, fx.rich.reference), A.finance),
      get(rosterPath(A.id, at(A.trips.shared, 0)), A.staff),
      get(exceptionsPath(A.id), A.finance),
    ]);
    expect(responses.map((r) => [r.status, r.headers.get("cache-control")])).toEqual(
      Array(responses.length).fill([200, "no-store"]),
    );
  });

  it("answers every route's refusals with Cache-Control: no-store too", async () => {
    const responses = await Promise.all([
      get(detailPath(A.id, randomUUID()), A.owner),
      get(referencePath(A.id, "ZZZZZZZZ"), A.owner),
      get(rosterPath(A.id, randomUUID()), A.owner),
      get(rosterPath(A.id, at(A.trips.shared, 0)), A.finance),
      get(dayPath(A.id, { date: fx.day.d0, after: randomUUID() }), A.owner),
      get(exceptionsPath(A.id, { before: randomUUID() }), A.owner),
      get(dayPath(B.id, { date: fx.day.d0 }), A.owner),
    ]);
    expect(responses.map((r) => [r.status, r.headers.get("cache-control")])).toEqual([
      [404, "no-store"],
      [404, "no-store"],
      [404, "no-store"],
      [403, "no-store"],
      [400, "no-store"],
      [400, "no-store"],
      [404, "no-store"],
    ]);
  });

  // Malformed queries and cursors -------------------------------------------------------------------------

  it("refuses malformed queries with validation_failed and cursors that name nothing with cursor_invalid", async () => {
    const d0 = fx.day.d0;
    const cases: [string, string, number, string][] = [
      ["no date", `${staffBase(A.id)}/bookings`, 400, "validation_failed"],
      ["date out of format", dayPath(A.id, { date: "2026-1-5" }), 400, "validation_failed"],
      ["date that does not exist", dayPath(A.id, { date: "2026-02-30" }), 400, "validation_failed"],
      ["limit 0", dayPath(A.id, { date: d0, limit: 0 }), 400, "validation_failed"],
      ["limit 201", dayPath(A.id, { date: d0, limit: 201 }), 400, "validation_failed"],
      ["limit text", dayPath(A.id, { date: d0, limit: "ten" }), 400, "validation_failed"],
      ["trip id text", dayPath(A.id, { date: d0, tripId: "trip" }), 400, "validation_failed"],
      ["after text", dayPath(A.id, { date: d0, after: "cursor" }), 400, "validation_failed"],
      ["after unknown", dayPath(A.id, { date: d0, after: randomUUID() }), 400, "cursor_invalid"],
      [
        "after names an exception",
        dayPath(A.id, { date: d0, after: fx.exceptionIds.lost }),
        400,
        "cursor_invalid",
      ],
      ["exceptions limit 0", exceptionsPath(A.id, { limit: 0 }), 400, "validation_failed"],
      ["exceptions limit 101", exceptionsPath(A.id, { limit: 101 }), 400, "validation_failed"],
      ["before text", exceptionsPath(A.id, { before: "cursor" }), 400, "validation_failed"],
      ["before unknown", exceptionsPath(A.id, { before: randomUUID() }), 400, "cursor_invalid"],
      [
        "before names a booking",
        exceptionsPath(A.id, { before: fx.rich.bookingId }),
        400,
        "cursor_invalid",
      ],
    ];
    const results = await Promise.all(
      cases.map(async ([name, path]) => [name, answer(await get(path, A.owner))] as const),
    );
    expect(Object.fromEntries(results)).toEqual(
      Object.fromEntries(cases.map(([name, , status, code]) => [name, refusal(status, code)])),
    );
    // The limits' edges are accepted.
    const edges = await Promise.all([
      get(dayPath(A.id, { date: d0, limit: 1 }), A.owner),
      get(dayPath(A.id, { date: d0, limit: 200 }), A.owner),
      get(exceptionsPath(A.id, { limit: 1 }), A.owner),
      get(exceptionsPath(A.id, { limit: 100 }), A.owner),
    ]);
    expect(edges.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  });

  it("answers a date the contract accepts in year 0000 without a server error", async () => {
    // LocalDate is z.iso.date(), which accepts 0000-01-01; PostgreSQL has no year 0.
    const res = await get(dayPath(A.id, { date: "0000-01-01" }), A.owner);
    expect(res.status, res.text).toBeLessThan(500);
    if (res.status === 400) expect(res.json.error?.code).toBe("validation_failed");
    else expect(BookingListResponse.parse(res.json)).toMatchObject({ trips: [], bookings: [] });
  });

  // Reads racing writes -----------------------------------------------------------------------------------

  // Last on purpose: it books D6, which no other test reads. A day's trips
  // carry counts "across all pages", so on a one-page day each count must
  // equal the bookings listed beside it, even while bookings confirm. Six
  // readers loop over the day while eight signed successes arrive at once;
  // the trip's lock makes them commit one after another. A torn read lists a
  // booking that its trip's count leaves out, or the reverse. Whether a run
  // catches one is a matter of timing, so a pass alone proves little; a
  // failure is a real reproduction.
  it("keeps a day's counts equal to the bookings it lists while bookings confirm", async () => {
    const tripId = at(A.trips.shared, 6);
    const opened = fx.racing;
    const count = opened.length;
    const reads: { counted: number; listed: number; guests: number; listedGuests: number }[] = [];
    let confirming = true;
    const reader = async () => {
      while (confirming) {
        const res = await get(dayPath(A.id, { date: fx.raceDay }), A.owner);
        if (res.status !== 200) throw new Error(`read: ${res.status} ${res.text}`);
        const list = BookingListResponse.parse(res.json);
        const trip = list.trips.find((t) => t.tripId === tripId);
        const own = list.bookings.filter((b) => b.tripId === tripId);
        expect(list.nextAfter).toBeNull();
        reads.push({
          counted: trip?.bookings ?? -1,
          listed: own.length,
          guests: trip?.guests ?? -1,
          listedGuests: sum(own.map((b) => b.party.guests)),
        });
      }
    };
    const readers = Array.from({ length: 6 }, () => reader());
    try {
      await Promise.all(opened.map((o) => deliver(A, o, ["confirmed", "confirmed_reacquired"])));
    } finally {
      confirming = false;
    }
    await Promise.all(readers);
    const torn = reads.filter((r) => r.counted !== r.listed || r.guests !== r.listedGuests);
    console.log(
      `CONSOLE_STATS ${JSON.stringify({ case: "counts_while_confirming", reads: reads.length, torn: torn.length, sample: torn.slice(0, 3) })}`,
    );
    expect(reads.length).toBeGreaterThanOrEqual(8);
    expect(torn).toEqual([]);
    // At rest the day agrees with itself.
    const settled = BookingListResponse.parse(
      (await get(dayPath(A.id, { date: fx.raceDay }), A.owner)).json,
    );
    expect(settled.trips.find((t) => t.tripId === tripId)).toMatchObject({
      bookings: count,
      guests: count,
    });
    expect(settled.bookings.filter((b) => b.tripId === tripId)).toHaveLength(count);
  });
});
