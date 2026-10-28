/**
 * G2.12d acceptance and adversarial tests for staff-assisted booking, through
 * the whole API as tidegrid_app (packages/contracts/src/staff-booking.ts).
 *
 * A staff booking is made the only way a booking is made: an offer, a quote,
 * a checkout that holds the party and writes the order and a pending payment,
 * and a booking only from a verified provider event. The staff test payment
 * settles the fake payment and posts its signed event to the real webhook
 * route. The suite checks:
 *
 * - owners and booking staff at two operators each book a shared-seat trip
 *   and a charter, confirmed only after the verified event, and see them as
 *   staff-assisted on the detail (with the staff member), search, the roster,
 *   and the CSV, with day totals equal to the ledger;
 * - finance is refused every route; a disabled member, a stranger, another
 *   tenant's ids, unknown, malformed, and guest-opened ids answer alike;
 * - idempotency on every command, the origin check, and the public entry;
 * - staff and guests racing for the last seats and for a whole boat, and many
 *   opens of one quote;
 * - closed, past-cutoff, canceled, and full trips refused with the guest codes;
 * - the confirmation email reaching the demo mailbox once with a working
 *   management link;
 * - a lost webhook delivery retried on the same key, a test payment on a
 *   canceled or expired checkout, and cancel racing pay;
 * - the per-staff open-checkout limit; and audit and outbox rows without
 *   booker data.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  BookingDayTotalsResponse,
  BookingDetailResponse,
  BookingSearchResponse,
  bookingDayExportColumns,
  QuoteResponse,
  StaffCheckoutCreateResponse,
  StaffCheckoutResponse,
  StaffTestPaymentResponse,
  TripOfferResponse,
  TripRosterResponse,
} from "@tidegrid/contracts";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type BookingHooks,
  CONFIRMATION_TEMPLATE,
  MAX_OPEN_CHECKOUTS_PER_CLIENT,
} from "@tidegrid/domain-booking";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  newSecret,
  quoteFor,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { changeTripSalesState } from "@tidegrid/domain-catalog";
import { systemContext, tripAllocator } from "@tidegrid/domain-inventory/testing";
import { deliverTenantMessages, FakeEmailProvider } from "@tidegrid/domain-messaging";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";

type Sql = ReturnType<typeof postgres>;
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field.
type Json = Record<string, any>;
type Res = { status: number; headers: Headers; json: Json; text: string };
type Tenant = CheckoutFixture & {
  host: string;
  owner: string;
  staff: string;
  finance: string;
  ownerId: string;
  staffId: string;
};
type Booker = { name: string; email: string };
type Channel = "phone" | "email" | "walk_up";

const env = inject("integrationDb");
const TEAM = "tidegrid-staff-booking.cloudflareaccess.com";
const AUD = "d4".repeat(32);
const CONSOLE = "https://console.test";
const LINK_ORIGIN = "https://{slug}.book.example.test";
const attestations = { policyToldToGuest: true, emailReadBack: true } as const;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every fragment of personal data the suite sends, lowercased. */
const personal: string[] = [];

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

/** A minimal RFC 4180 reader for the export; it drops the byte order mark. */
function parseCsv(withMark: string): string[][] {
  const text = withMark.replace(/^﻿/, "");
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
  return rows;
}

describe.skipIf(!env)("G2.12d staff-assisted booking through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let verifier: ReturnType<typeof createAccessVerifier>;
  let signingKey: CryptoKey;
  let mail: FakeEmailProvider;
  let A: Tenant;
  let B: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let disabled: string;
  let stranger: string;
  const kid = `kid-${randomUUID().slice(0, 8)}`;
  let bookerCount = 0;
  let addressCount = 0;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: [CONSOLE, ...[A, B].map((t) => `https://${t.host}`)].join(","),
    STAFF_ORIGINS: CONSOLE,
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    EMAIL_PROVIDER: "fake",
    GUEST_LINK_ORIGIN: LINK_ORIGIN,
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  function booker(label: string): Booker {
    bookerCount += 1;
    const who = {
      name: `Staffbooked ${label} Guestname${bookerCount}`,
      email: `staffbooked.${label}.${bookerCount}@guest.example`,
    };
    personal.push(who.email, `guestname${bookerCount}`);
    return who;
  }

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
      origin?: string | null;
      as?: string;
      body?: unknown;
      headers?: Record<string, string>;
      via?: ReturnType<typeof createApp>;
      host?: string;
    } = {},
  ): Promise<Res> {
    const headers = new Headers(opts.headers);
    const origin = opts.origin === undefined ? CONSOLE : opts.origin;
    if (origin) headers.set("origin", origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const res = await (opts.via ?? app).request(
      `http://${opts.host ?? "localhost"}${path}`,
      { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) },
      bindings(),
      executionCtx,
    );
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = {};
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  // Paths and calls ----------------------------------------------------------------------

  const base = (tenantId: string) => `/v1/staff/tenants/${encodeURIComponent(tenantId)}`;
  const offerPath = (t: string, trip: string) =>
    `${base(t)}/trips/${encodeURIComponent(trip)}/offer`;
  const quotesPath = (t: string) => `${base(t)}/quotes`;
  const checkoutsPath = (t: string) => `${base(t)}/checkouts`;
  const checkoutPath = (t: string, id: string) => `${base(t)}/checkouts/${encodeURIComponent(id)}`;
  const key = (label: string) => `${label}-${randomUUID()}`;

  const offer = (t: string, as: string, trip: string) => request("GET", offerPath(t, trip), { as });
  const quote = (t: string, as: string, body: unknown, k = key("q")) =>
    request("POST", quotesPath(t), { as, body, headers: { "idempotency-key": k } });
  const open = (t: string, as: string, body: unknown, k = key("o")) =>
    request("POST", checkoutsPath(t), { as, body, headers: { "idempotency-key": k } });
  const read = (t: string, as: string, id: string) => request("GET", checkoutPath(t, id), { as });
  const cancel = (t: string, as: string, id: string, k = key("c")) =>
    request("POST", `${checkoutPath(t, id)}/cancel`, { as, headers: { "idempotency-key": k } });
  const testPay = (
    t: string,
    as: string,
    id: string,
    outcome: "succeed" | "fail",
    k = key("p"),
    via?: ReturnType<typeof createApp>,
  ) =>
    request("POST", `${checkoutPath(t, id)}/test-payment`, {
      as,
      body: { outcome },
      headers: { "idempotency-key": k },
      ...(via ? { via } : {}),
    });

  const tickets = (tripId: string, n: number) => ({
    tripId,
    party: { kind: "tickets", tickets: [{ code: "adult", quantity: n }] },
    addOns: [],
  });
  const aboard = (tripId: string, n: number) => ({
    tripId,
    party: { kind: "charter", guests: n },
    addOns: [],
  });

  /** A staff quote through the API. */
  async function staffQuote(t: Tenant, as: string, body: unknown) {
    const res = await quote(t.id, as, body);
    if (res.status !== 201) throw new Error(`quote: ${res.status} ${res.text}`);
    return QuoteResponse.parse(res.json).quote;
  }

  const openBody = (
    q: { quoteId: string; policy: { version: number } },
    who: Booker,
    channel: Channel = "phone",
  ) => ({
    quoteId: q.quoteId,
    acceptedPolicyVersion: q.policy.version,
    booker: who,
    channel,
    attestations,
  });

  interface Made {
    tripId: string;
    checkoutId: string;
    bookingId: string;
    reference: string;
    booker: Booker;
    channel: Channel;
  }

  /** Offer, quote, open, and take the test payment, as the console does. */
  async function bookAsStaff(
    t: Tenant,
    as: string,
    tripId: string,
    body: unknown,
    channel: Channel = "phone",
  ): Promise<Made> {
    const offered = await offer(t.id, as, tripId);
    if (offered.status !== 200) throw new Error(`offer: ${offered.status} ${offered.text}`);
    TripOfferResponse.parse(offered.json);
    const q = await staffQuote(t, as, body);
    const who = booker(channel);
    const opened = await open(t.id, as, openBody(q, who, channel));
    if (opened.status !== 201) throw new Error(`open: ${opened.status} ${opened.text}`);
    const { checkout, paymentReady } = StaffCheckoutCreateResponse.parse(opened.json);
    expect(paymentReady).toBe(true);
    // Nothing is booked before the verified event.
    expect(checkout).toMatchObject({ state: "open", paymentState: "pending", booking: null });
    const [none] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.bookings where checkout_session_id = ${checkout.id}`;
    expect(none?.n).toBe(0);
    const paid = await testPay(t.id, as, checkout.id, "succeed");
    if (paid.status !== 200) throw new Error(`pay: ${paid.status} ${paid.text}`);
    const result = StaffTestPaymentResponse.parse(paid.json);
    expect(result.delivery).toMatchObject({ status: 200, outcome: "confirmed" });
    const after = StaffCheckoutResponse.parse((await read(t.id, as, checkout.id)).json).checkout;
    expect(after).toMatchObject({ state: "confirmed", paymentState: "succeeded" });
    if (!after.booking) throw new Error("no booking on a confirmed staff checkout");
    return {
      tripId,
      checkoutId: checkout.id,
      bookingId: after.booking.id,
      reference: after.booking.reference,
      booker: who,
      channel,
    };
  }

  /** A guest's open checkout through the public route, for races. */
  async function guestOpen(t: Tenant, q: { quoteId: string; policy: { version: number } }) {
    return request("POST", "/v1/public/checkout-sessions", {
      origin: `https://${t.host}`,
      body: {
        quoteId: q.quoteId,
        acceptedPolicyVersion: q.policy.version,
        booker: booker("guest"),
        checkoutSecret: newSecret(),
      },
      headers: {
        "idempotency-key": key("g"),
        "cf-connecting-ip": `198.51.100.${(addressCount++ % 250) + 1}`,
      },
    });
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
    return userId;
  }

  async function withAccess(f: CheckoutFixture, label: string): Promise<Tenant> {
    const host = `${f.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${f.id}, 'preview', 'active', now())`;
    const mailOf = (role: string) => `${label}-${role}-${f.id.slice(0, 8)}@example.test`;
    const ownerId = await member(f.id, mailOf("owner"), "owner", "active", "Olive Owner");
    const staffId = await member(f.id, mailOf("staff"), "booking_staff", "active", "Ben Desk");
    await member(f.id, mailOf("finance"), "finance", "active", "Fay Books");
    return {
      ...f,
      host,
      owner: mailOf("owner"),
      staff: mailOf("staff"),
      finance: mailOf("finance"),
      ownerId,
      staffId,
    };
  }

  async function dateOf(tripId: string): Promise<string> {
    const [row] = await admin<{ d: string }[]>`
      select local_date::text as d from public.scheduled_trips where id = ${tripId}`;
    if (!row) throw new Error(`no trip ${tripId}`);
    return row.d;
  }

  async function usage(tripId: string) {
    const [row] = await admin<{ counted: number; capacity: number; boats: number }[]>`
      select coalesce(sum(h.seats), 0)::int as counted, t.seat_capacity as capacity,
             count(*) filter (where h.kind = 'whole_boat')::int as boats
        from public.scheduled_trips t
        left join public.capacity_holds h
          on h.trip_id = t.id and h.state in ('active', 'confirmed')
       where t.id = ${tripId}
       group by t.seat_capacity`;
    return row;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 10 });
    mail = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    verifier = createAccessVerifier({
      teamDomain: TEAM,
      audience: AUD,
      keys: createLocalJWKSet({ keys: [jwk] }),
    });
    app = createApp({ accessVerifier: verifier, deliverEmailAfterCommit: false });
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "g212d-api-a", { days: 30 }),
      createCheckoutFixture(admin, runtime.db, "g212d-api-b", { days: 8 }),
    ]);
    A = await withAccess(a, "g212d-a");
    B = await withAccess(b, "g212d-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    const disabledEmail = `g212d-a-disabled-${A.id.slice(0, 8)}@example.test`;
    await member(A.id, disabledEmail, "booking_staff", "disabled");
    disabled = disabledEmail;
    stranger = B.staff;
  }, 300_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  // Acceptance 1 -----------------------------------------------------------------------------

  it("books a shared-seat trip and a charter as owner and as booking staff, at both operators, and shows them as staff-assisted everywhere", async () => {
    const shared = tripsA.shared();
    const charter = tripsA.charter();
    const made = [
      await bookAsStaff(A, A.staff, shared, tickets(shared, 2), "phone"),
      await bookAsStaff(A, A.owner, shared, tickets(shared, 1), "walk_up"),
      await bookAsStaff(A, A.staff, charter, aboard(charter, 4), "email"),
    ];
    const bCharter = tripsB.charter();
    const bShared = tripsB.shared();
    const bMade = [
      await bookAsStaff(B, B.owner, bCharter, aboard(bCharter, 3), "phone"),
      await bookAsStaff(B, B.staff, bShared, tickets(bShared, 2), "walk_up"),
    ];
    const aCharter2 = tripsA.charter();
    made.push(await bookAsStaff(A, A.owner, aCharter2, aboard(aCharter2, 2), "phone"));

    for (const [t, list] of [
      [A, made],
      [B, bMade],
    ] as const) {
      for (const m of list) {
        const [stored] = await admin<{ source: string; opened_by: string; channel: string }[]>`
          select b.source, s.opened_by, s.channel from public.bookings b
            join public.checkout_sessions s on s.id = b.checkout_session_id
           where b.id = ${m.bookingId}`;
        expect(stored).toMatchObject({ source: "staff_assisted", channel: m.channel });

        // Detail, for owner, staff, and finance (D14: every role sees who booked it).
        for (const as of [t.owner, t.staff, t.finance]) {
          const res = await request("GET", `${base(t.id)}/bookings/${m.bookingId}`, { as });
          expect(res.status, res.text).toBe(200);
          const { booking } = BookingDetailResponse.parse(res.json);
          expect(booking).toMatchObject({
            source: "staff_assisted",
            channel: m.channel,
            openedBy: { displayName: expect.stringMatching(/^(Olive Owner|Ben Desk)$/) },
          });
          expect(booking.openedBy?.userId).toBe(stored?.opened_by);
        }

        // Search by reference.
        const found = await request("POST", `${base(t.id)}/booking-searches`, {
          as: t.staff,
          body: { q: m.reference },
        });
        const results = BookingSearchResponse.parse(found.json).results;
        expect(results.find((r) => r.id === m.bookingId)?.source).toBe("staff_assisted");

        // The roster.
        const roster = await request("GET", `${base(t.id)}/trips/${m.tripId}/roster`, {
          as: t.staff,
        });
        const parsed = TripRosterResponse.parse(roster.json).roster;
        // The roster carries the calendar's Book rule inputs (review UI-7).
        const [closes] = await admin<{ at: Date }[]>`
          select t.starts_at - make_interval(mins => p.booking_cutoff_minutes) as at
            from public.scheduled_trips t join public.products p on p.id = t.product_id
           where t.id = ${m.tripId}`;
        expect(parsed.trip).toMatchObject({
          blackedOut: false,
          salesCloseAt: closes?.at.toISOString(),
        });
        const listed = parsed.bookings.find((b) => b.id === m.bookingId);
        expect(listed).toMatchObject({ source: "staff_assisted", channel: m.channel });
      }
    }
    // The opener names the staff member who opened it.
    const [openers] = await admin<{ staff: string; owner: string }[]>`
      select (select opened_by::text from public.checkout_sessions where id = ${made[0]?.checkoutId ?? ""}) as staff,
             (select opened_by::text from public.checkout_sessions where id = ${made[1]?.checkoutId ?? ""}) as owner`;
    expect(openers).toEqual({ staff: A.staffId, owner: A.ownerId });

    // A's day: totals equal the ledger, and the CSV keeps the sources apart.
    for (const tripId of [shared, charter]) {
      const date = await dateOf(tripId);
      const totals = await request(
        "GET",
        `${base(A.id)}/booking-day-totals?${new URLSearchParams({ date })}`,
        { as: A.finance },
      );
      expect(totals.status, totals.text).toBe(200);
      const t = BookingDayTotalsResponse.parse(totals.json).totals;
      const [ledger] = await admin<{ bookings: number; guests: number; total: number }[]>`
        select count(*) filter (where b.state = 'confirmed')::int as bookings,
               coalesce(sum(b.party_size) filter (where b.state = 'confirmed'), 0)::int as guests,
               coalesce(sum(o.total_amount), 0)::int as total
          from public.bookings b
          join public.scheduled_trips t on t.id = b.trip_id
          join public.orders o on o.id = b.order_id
         where b.tenant_id = ${A.id} and t.local_date = ${date}::date`;
      expect({ bookings: t.bookings, guests: t.guests, total: t.total }).toEqual(ledger);

      for (const as of [A.owner, A.finance]) {
        const exported = await request(
          "GET",
          `${base(A.id)}/booking-day-export?${new URLSearchParams({ date })}`,
          { as },
        );
        expect(exported.status).toBe(200);
        const rows = parseCsv(exported.text);
        const header = rows[0] ?? [];
        expect(header.slice(0, bookingDayExportColumns.length)).toEqual([
          ...bookingDayExportColumns,
        ]);
        const at = (r: string[] | undefined, column: string) => r?.[header.indexOf(column)];
        for (const m of made.filter((x) => x.tripId === tripId)) {
          const line = rows.find((r) => at(r, "Booking reference") === m.reference);
          expect(at(line, "Source")).toBe("staff_assisted");
        }
        expect(at(rows.at(-1), "Row")).toBe("Total");
        expect(at(rows.at(-1), "Source")).toBe("");
      }
    }
  });

  // Acceptance 2 and 3 -----------------------------------------------------------------------

  it("refuses finance every route, and answers a disabled member and a stranger as an unknown tenant", async () => {
    const tripId = tripsA.shared();
    const q = await staffQuote(A, A.staff, tickets(tripId, 1));
    const opened = await open(A.id, A.staff, openBody(q, booker("roles")));
    const checkoutId = StaffCheckoutCreateResponse.parse(opened.json).checkout.id;
    const calls = (as: string) => [
      offer(A.id, as, tripId),
      quote(A.id, as, tickets(tripId, 1)),
      open(A.id, as, openBody(q, booker("roles"))),
      read(A.id, as, checkoutId),
      cancel(A.id, as, checkoutId),
      testPay(A.id, as, checkoutId, "succeed"),
    ];
    for (const [as, status, code] of [
      [A.finance, 403, "forbidden"],
      [disabled, 404, "tenant_not_found"],
      [stranger, 404, "tenant_not_found"],
    ] as const) {
      const replies = await Promise.all(calls(as));
      expect(replies.map((r) => [r.status, r.json.error?.code])).toEqual(
        Array(6).fill([status, code]),
      );
    }
    // Nothing moved: the checkout is still open and unpaid.
    expect(
      StaffCheckoutResponse.parse((await read(A.id, A.staff, checkoutId)).json).checkout,
    ).toMatchObject({ state: "open", paymentState: "pending", lastTestPayment: null });
    expect((await cancel(A.id, A.staff, checkoutId)).status).toBe(200);

    // A suspended tenant refuses every route.
    await admin`update public.tenants set status = 'suspended' where id = ${B.id}`;
    try {
      const replies = await Promise.all([
        offer(B.id, B.staff, tripsB.shared()),
        quote(B.id, B.staff, tickets(tripsB.shared(), 1)),
        read(B.id, B.staff, randomUUID()),
      ]);
      expect(replies.map((r) => [r.status, r.json.error?.code])).toEqual(
        Array(3).fill([403, "tenant_suspended"]),
      );
    } finally {
      await admin`update public.tenants set status = 'active' where id = ${B.id}`;
    }
  });

  it("answers another tenant's trips, quotes, and checkouts as unknown, malformed, and guest-opened ones", async () => {
    const bTrip = tripsB.shared();
    const bQuote = await staffQuote(B, B.staff, tickets(bTrip, 1));
    const bOpened = await open(B.id, B.staff, openBody(bQuote, booker("b")));
    const bCheckout = StaffCheckoutCreateResponse.parse(bOpened.json).checkout.id;
    // A guest's checkout at A, and a guest's quote at A.
    const guestQuote = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
    const guest = await guestOpen(A, guestQuote);
    expect(guest.status).toBe(201);
    const guestCheckout = guest.json.checkoutSession.id as string;

    for (const tripId of [bTrip, randomUUID(), "not-a-trip"]) {
      expect([(await offer(A.id, A.staff, tripId)).json.error?.code]).toEqual(["trip_not_found"]);
      const q = await quote(A.id, A.staff, tickets(randomUUID(), 1));
      expect([q.status, q.json.error?.code]).toEqual([404, "trip_not_found"]);
    }
    const bTripQuote = await quote(A.id, A.staff, tickets(bTrip, 1));
    expect([bTripQuote.status, bTripQuote.json.error?.code]).toEqual([404, "trip_not_found"]);
    for (const q of [bQuote, guestQuote, { ...bQuote, quoteId: randomUUID() }]) {
      const res = await open(A.id, A.staff, openBody(q, booker("cross")));
      expect([res.status, res.json.error?.code]).toEqual([404, "quote_not_found"]);
    }
    for (const id of [bCheckout, guestCheckout, randomUUID(), "not-a-checkout"]) {
      const replies = [
        await read(A.id, A.staff, id),
        await cancel(A.id, A.staff, id),
        await testPay(A.id, A.staff, id, "succeed"),
      ];
      expect({ id, answers: replies.map((r) => [r.status, r.json.error?.code]) }).toEqual({
        id,
        answers: Array(3).fill([404, "checkout_not_found"]),
      });
    }
    // B's checkout and A's guest checkout are untouched.
    const [states] = await admin<{ b: string; g: string; events: number }[]>`
      select (select state from public.checkout_sessions where id = ${bCheckout}) as b,
             (select state from public.checkout_sessions where id = ${guestCheckout}) as g,
             (select count(*)::int from public.fake_provider_events e
                join public.payments p on p.provider_payment_id = e.payment_id
               where p.checkout_session_id in (${bCheckout}, ${guestCheckout})) as events`;
    expect(states).toEqual({ b: "open", g: "open", events: 0 });
  });

  // Acceptance 4 -----------------------------------------------------------------------------

  it("replays every command by key, refuses the key with another body, and needs a key, the console origin, and the console entry", async () => {
    const tripId = tripsA.shared();
    // R2
    const qKey = key("q");
    const q1 = await quote(A.id, A.staff, tickets(tripId, 2), qKey);
    const q2 = await quote(A.id, A.staff, tickets(tripId, 2), qKey);
    expect([q1.status, q2.status, q2.headers.get("idempotent-replayed")]).toEqual([
      201,
      201,
      "true",
    ]);
    expect(q2.json).toEqual(q1.json);
    expect((await quote(A.id, A.staff, tickets(tripId, 3), qKey)).json.error?.code).toBe(
      "idempotency_key_reused",
    );
    const q = QuoteResponse.parse(q1.json).quote;

    // R3: one checkout and one provider payment, however often it is sent.
    const oKey = key("o");
    const who = booker("idem");
    const o1 = await open(A.id, A.staff, openBody(q, who), oKey);
    const o2 = await open(A.id, A.staff, openBody(q, who), oKey);
    expect([o1.status, o2.status, o2.headers.get("idempotent-replayed")]).toEqual([
      201,
      201,
      "true",
    ]);
    expect(o2.json.checkout).toEqual(o1.json.checkout);
    expect(keysOf(o1.json).has("clientSecret")).toBe(false);
    expect(keysOf(o1.json).has("paymentRef")).toBe(false);
    const checkoutId = o1.json.checkout.id as string;
    const reused = await open(A.id, A.staff, openBody(q, who, "email"), oKey);
    expect([reused.status, reused.json.error?.code]).toEqual([422, "idempotency_key_reused"]);
    const [payments] = await admin<{ ours: number; fake: number }[]>`
      select count(*)::int as ours,
             (select count(*)::int from public.fake_provider_payments f
                join public.payments p on p.provider_payment_id = f.id
               where p.checkout_session_id = ${checkoutId}) as fake
        from public.payments where checkout_session_id = ${checkoutId}`;
    expect(payments).toEqual({ ours: 1, fake: 1 });

    // R6: a replay delivers the same event again; the webhook records it once.
    const pKey = key("p");
    const p1 = await testPay(A.id, A.staff, checkoutId, "succeed", pKey);
    const p2 = await testPay(A.id, A.staff, checkoutId, "succeed", pKey);
    expect([p1.status, p2.status, p2.headers.get("idempotent-replayed")]).toEqual([
      200,
      200,
      "true",
    ]);
    expect(p1.json).toMatchObject({ alreadySettled: false, delivery: { outcome: "confirmed" } });
    expect(p2.json).toMatchObject({
      alreadySettled: true,
      event: { id: p1.json.event.id },
      delivery: { status: 200, duplicate: true },
    });
    expect((await testPay(A.id, A.staff, checkoutId, "fail", pKey)).json.error?.code).toBe(
      "idempotency_key_reused",
    );
    // A new key after confirmation: the checkout is no longer open.
    const late = await testPay(A.id, A.staff, checkoutId, "succeed");
    expect([late.status, late.json.error?.code]).toEqual([409, "checkout_not_open"]);
    const [booked] = await admin<{ n: number; events: number }[]>`
      select count(*)::int as n,
             (select count(*)::int from public.provider_events e
               where e.event_id = ${p1.json.event.id as string}) as events
        from public.bookings where checkout_session_id = ${checkoutId}`;
    expect(booked).toEqual({ n: 1, events: 1 });

    // R5
    const other = await open(
      A.id,
      A.staff,
      openBody(await staffQuote(A, A.staff, tickets(tripId, 1)), booker("idem")),
    );
    const otherId = other.json.checkout.id as string;
    const cKey = key("c");
    const c1 = await cancel(A.id, A.staff, otherId, cKey);
    const c2 = await cancel(A.id, A.staff, otherId, cKey);
    expect([c1.status, c2.status, c2.headers.get("idempotent-replayed")]).toEqual([
      200,
      200,
      "true",
    ]);
    expect(c1.json.checkout.state).toBe("canceled");
    // The same key on another checkout is another request.
    expect((await cancel(A.id, A.staff, checkoutId, cKey)).json.error?.code).toBe(
      "idempotency_key_reused",
    );

    // No key, no console origin, and the public entry.
    for (const [method, path, body] of [
      ["POST", quotesPath(A.id), tickets(tripId, 1)],
      ["POST", checkoutsPath(A.id), openBody(q, who)],
      ["POST", `${checkoutPath(A.id, otherId)}/cancel`, undefined],
      ["POST", `${checkoutPath(A.id, otherId)}/test-payment`, { outcome: "succeed" }],
    ] as const) {
      const noKey = await request(method, path, { as: A.staff, body });
      expect([path, noKey.status]).toEqual([path, 400]);
      const noOrigin = await request(method, path, {
        as: A.staff,
        body,
        origin: null,
        headers: { "idempotency-key": key("x") },
      });
      expect([path, noOrigin.status, noOrigin.json.error?.code]).toEqual([
        path,
        403,
        "origin_not_allowed",
      ]);
      const publicEntry = await request(method, path, {
        as: A.staff,
        body,
        host: "api.example.test",
        headers: { "idempotency-key": key("x") },
      });
      expect([path, publicEntry.status, publicEntry.json.error?.code]).toEqual([
        path,
        404,
        "not_found",
      ]);
    }
  });

  // Acceptance 5 -----------------------------------------------------------------------------

  it("never oversells when staff and guests race for the last seats and for a whole boat, and opens one checkout per quote", async () => {
    for (let round = 0; round < 3; round++) {
      // Seven of ten seats taken; one staff party of two and four guest parties of two race.
      const tripId = tripsA.shared();
      const prefill = await guestOpen(A, await quoteFor(runtime.db, A.id, tripId, 7));
      expect(prefill.status).toBe(201);
      const staffQ = await staffQuote(A, A.staff, tickets(tripId, 2));
      const guestQs = await Promise.all(
        Array.from({ length: 4 }, () => quoteFor(runtime.db, A.id, tripId, 2)),
      );
      const replies = await Promise.all([
        open(A.id, A.staff, openBody(staffQ, booker("race"))),
        ...guestQs.map((g) => guestOpen(A, g)),
      ]);
      expect(replies.filter((r) => r.status !== 201 && r.status !== 409)).toEqual([]);
      for (const r of replies.filter((x) => x.status === 409)) {
        expect(r.json.error?.code).toBe("insufficient_capacity");
      }
      expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
      expect((await usage(tripId))?.counted).toBe(9);
      // A staff winner is canceled so the per-staff limit stays clear for later tests.
      if (replies[0]?.status === 201) {
        expect((await cancel(A.id, A.staff, replies[0].json.checkout.id)).status).toBe(200);
      }

      // A whole boat: one staff open and four guests, one wins.
      const boat = tripsA.charter();
      const boatStaff = await staffQuote(A, A.owner, aboard(boat, 3));
      const boatGuests = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          quoteFor(runtime.db, A.id, boat, 2 + i, { charter: true }),
        ),
      );
      const boatReplies = await Promise.all([
        open(A.id, A.owner, openBody(boatStaff, booker("boat"))),
        ...boatGuests.map((g) => guestOpen(A, g)),
      ]);
      expect(boatReplies.filter((r) => r.status === 201)).toHaveLength(1);
      expect(
        boatReplies.filter(
          (r) => r.status === 409 && r.json.error?.code === "insufficient_capacity",
        ),
      ).toHaveLength(4);
      expect((await usage(boat))?.boats).toBe(1);
      if (boatReplies[0]?.status === 201) {
        expect((await cancel(A.id, A.owner, boatReplies[0].json.checkout.id)).status).toBe(200);
      }
    }
    // Many opens of one quote, each with its own key: one checkout.
    const tripId = tripsA.shared();
    const one = await staffQuote(A, A.staff, tickets(tripId, 1));
    const who = booker("same");
    const replies = await Promise.all(
      Array.from({ length: 6 }, () => open(A.id, A.owner, openBody(one, who))),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      replies.filter((r) => r.status === 409 && r.json.error?.code === "quote_already_used"),
    ).toHaveLength(5);
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.checkout_sessions where quote_id = ${one.quoteId}`;
    expect(count?.n).toBe(1);
    // Leave no open staff checkout behind for the per-staff limit.
    const winner = replies.find((r) => r.status === 201);
    expect((await cancel(A.id, A.owner, winner?.json.checkout.id ?? "")).status).toBe(200);
  });

  // Acceptance 6 -----------------------------------------------------------------------------

  it("refuses closed, past-cutoff, canceled, and full trips with the guest's codes", async () => {
    const ctx = systemContext(A.id, "g212d");
    const closed = tripsA.shared();
    const canceled = tripsA.shared();
    for (const [tripId, to] of [
      [closed, "closed"],
      [canceled, "canceled"],
    ] as const) {
      const changed = await inTenantTransaction(runtime.db, ctx, (trx) =>
        changeTripSalesState(trx, ctx, { tripId, to, reason: "g212d", now: new Date() }),
      );
      expect(changed.kind).not.toBe("conflict");
    }
    const late = A.trips.late[0] ?? "";
    for (const tripId of [closed, canceled, late]) {
      const o = await offer(A.id, A.staff, tripId);
      expect([tripId, o.status, o.json.error?.code]).toEqual([tripId, 409, "trip_not_bookable"]);
      const q = await quote(A.id, A.staff, tickets(tripId, 1));
      expect([tripId, q.status, q.json.error?.code]).toEqual([tripId, 409, "trip_not_bookable"]);
    }
    // Quoted while on sale, then closed before the checkout: refused at open.
    const closing = tripsA.shared();
    const q = await staffQuote(A, A.staff, tickets(closing, 1));
    await inTenantTransaction(runtime.db, ctx, (trx) =>
      changeTripSalesState(trx, ctx, {
        tripId: closing,
        to: "closed",
        reason: "g212d",
        now: new Date(),
      }),
    );
    const refused = await open(A.id, A.staff, openBody(q, booker("closed")));
    expect([refused.status, refused.json.error?.code]).toEqual([409, "trip_not_bookable"]);

    // Full: a guest holds all ten seats.
    const full = tripsA.shared();
    const filler = await staffQuote(A, A.staff, tickets(full, 1));
    expect((await guestOpen(A, await quoteFor(runtime.db, A.id, full, 8))).status).toBe(201);
    expect((await guestOpen(A, await quoteFor(runtime.db, A.id, full, 2))).status).toBe(201);
    // A sold-out trip is off sale to a new quote, as for a guest.
    const fullQuote = await quote(A.id, A.staff, tickets(full, 1));
    expect(fullQuote.status).toBe(409);
    expect(["trip_not_bookable", "insufficient_capacity"]).toContain(fullQuote.json.error?.code);
    const fullOpen = await open(A.id, A.staff, openBody(filler, booker("full")));
    expect([fullOpen.status, fullOpen.json.error?.code]).toEqual([409, "insufficient_capacity"]);
  });

  // Acceptance 7 -----------------------------------------------------------------------------

  it("sends the confirmation to the guest's mailbox once, and its link opens the booking", async () => {
    const tripId = tripsA.shared();
    const made = await bookAsStaff(A, A.staff, tripId, tickets(tripId, 1), "phone");
    const deliver = () =>
      deliverTenantMessages(runtime.db, A.id, {
        provider: mail,
        fromAddress: "bookings@tidegrid.test",
        guestLinkOrigin: LINK_ORIGIN,
        runId: `run-${randomUUID()}`,
      });
    await deliver();
    await deliver();
    const messages = await admin<
      { id: string; template: string; state: string; to_email: string }[]
    >`
      select id, template, state, to_email from public.email_messages
       where booking_id = ${made.bookingId} and template = ${CONFIRMATION_TEMPLATE.key}`;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ state: "sent", to_email: made.booker.email });
    const deliveries = await admin<{ html_body: string }[]>`
      select html_body from public.fake_email_deliveries
       where idempotency_key = ${messages[0]?.id ?? ""} and result = 'accepted'`;
    expect(deliveries).toHaveLength(1);
    const linkToken = /#t=([A-Za-z0-9_-]{43})/.exec(deliveries[0]?.html_body ?? "")?.[1];
    expect(linkToken).toBeTruthy();
    const [link] = await admin<{ purpose: string }[]>`
      select purpose from public.guest_access_links
       where token_hash = ${sha256(`access-link:${linkToken}`)}`;
    expect(link?.purpose).toBe("booking_manage");
    const opened = await request("POST", "/v1/public/booking-access", {
      origin: `https://${A.host}`,
      body: { token: linkToken },
    });
    expect(opened.status, opened.text).toBe(201);
    expect(opened.json.booking.reference).toBe(made.reference);
  });

  // Acceptance 11 and 12 ---------------------------------------------------------------------

  it("posts the stored event again on a retry with the same key after a lost delivery, and books once", async () => {
    let calls = 0;
    const flaky: BookingHooks = {
      bookingConfirmed: async () => {
        calls += 1;
        if (calls === 1) throw new Error("injected: the first delivery fails");
      },
    };
    const flakyApp = createApp({
      accessVerifier: verifier,
      deliverEmailAfterCommit: false,
      bookingHooks: flaky,
    });
    const tripId = tripsA.shared();
    const q = await staffQuote(A, A.staff, tickets(tripId, 2));
    const opened = await open(A.id, A.staff, openBody(q, booker("lost")));
    const checkoutId = opened.json.checkout.id as string;
    const pKey = key("lost");
    const first = await testPay(A.id, A.staff, checkoutId, "succeed", pKey, flakyApp);
    expect(first.status).toBe(200);
    expect(first.json.delivery.status).toBeGreaterThanOrEqual(500);
    expect((await read(A.id, A.staff, checkoutId)).json.checkout).toMatchObject({
      state: "open",
      booking: null,
    });
    const retry = await testPay(A.id, A.staff, checkoutId, "succeed", pKey, flakyApp);
    expect([retry.status, retry.headers.get("idempotent-replayed")]).toEqual([200, "true"]);
    expect(retry.json).toMatchObject({
      alreadySettled: true,
      event: { id: first.json.event.id },
      delivery: { status: 200, outcome: "confirmed" },
    });
    const [booked] = await admin<{ n: number; source: string }[]>`
      select count(*)::int as n, max(source) as source from public.bookings
       where checkout_session_id = ${checkoutId}`;
    expect(booked).toEqual({ n: 1, source: "staff_assisted" });
  });

  it("settles nothing for a canceled or expired checkout, and cancel racing pay never books a canceled checkout", async () => {
    const tripId = tripsA.shared();
    const q = await staffQuote(A, A.staff, tickets(tripId, 1));
    const opened = await open(A.id, A.staff, openBody(q, booker("cxl")));
    const id = opened.json.checkout.id as string;
    expect((await cancel(A.id, A.staff, id)).json.checkout.state).toBe("canceled");
    const refused = await testPay(A.id, A.staff, id, "succeed");
    expect([refused.status, refused.json.error?.code]).toEqual([409, "checkout_not_open"]);

    const q2 = await staffQuote(A, A.staff, tickets(tripId, 1));
    const expiring = await open(A.id, A.staff, openBody(q2, booker("exp")));
    const expId = expiring.json.checkout.id as string;
    await admin`
      with s as (update public.checkout_sessions set expires_at = now() - interval '1 second'
                  where id = ${expId} returning hold_id, expires_at)
      update public.capacity_holds h set expires_at = least(h.expires_at, s.expires_at)
        from s where h.id = s.hold_id`;
    expect((await read(A.id, A.staff, expId)).json.checkout.state).toBe("expired");
    const late = await testPay(A.id, A.staff, expId, "succeed");
    expect([late.status, late.json.error?.code]).toEqual([409, "checkout_not_open"]);
    const [settled] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.fake_provider_events e
        join public.payments p on p.provider_payment_id = e.payment_id
       where p.checkout_session_id in (${id}, ${expId})`;
    expect(settled?.n).toBe(0);

    // Cancel and pay at once, many times. Each ends confirmed, canceled, or
    // unfulfilled and refunded in full with an exception: never a booking on
    // a canceled checkout.
    for (let round = 0; round < 6; round++) {
      const trip = tripsA.shared();
      const rq = await staffQuote(A, A.owner, tickets(trip, 1));
      const ro = await open(A.id, A.owner, openBody(rq, booker("race")));
      const rid = ro.json.checkout.id as string;
      const [c, p] = await Promise.all([
        cancel(A.id, A.owner, rid),
        testPay(A.id, A.owner, rid, "succeed"),
      ]);
      const [state] = await admin<
        { state: string; bookings: number; refund: string | null; exceptions: number }[]
      >`
        select s.state,
               (select count(*)::int from public.bookings b where b.checkout_session_id = s.id) as bookings,
               (select r.state from public.payment_refunds r
                  join public.payments pay on pay.id = r.payment_id
                 where pay.checkout_session_id = s.id) as refund,
               (select count(*)::int from public.finalization_exceptions f
                 where f.checkout_session_id = s.id) as exceptions
          from public.checkout_sessions s where s.id = ${rid}`;
      const outcome = { cancel: c.status, pay: p.status, ...state };
      if (state?.state === "confirmed") {
        expect(outcome).toMatchObject({ cancel: 409, pay: 200, bookings: 1, refund: null });
      } else if (state?.state === "canceled") {
        expect(outcome).toMatchObject({ cancel: 200, pay: 409, bookings: 0, refund: null });
      } else {
        expect(outcome).toMatchObject({
          state: "unfulfilled",
          cancel: 200,
          pay: 200,
          bookings: 0,
          refund: "succeeded",
          exceptions: 1,
        });
      }
    }
  });

  // Review fixes (R6 replay, R3) ---------------------------------------------------------------

  it("settles nothing on a replay after the checkout was canceled, when the first settle never happened", async () => {
    const tripId = tripsA.shared();
    const q = await staffQuote(A, A.staff, tickets(tripId, 1));
    const opened = await open(A.id, A.staff, openBody(q, booker("replay")));
    const id = opened.json.checkout.id as string;
    const pKey = key("replay");
    // The fake's storage refuses the settle: phase 1 is recorded, phase 2 answers 503.
    await admin`revoke insert on public.fake_provider_events from tidegrid_app`;
    let first: Res;
    try {
      first = await testPay(A.id, A.staff, id, "succeed", pKey);
    } finally {
      await admin`grant insert on public.fake_provider_events to tidegrid_app`;
    }
    expect([first.status, first.json.error?.code]).toEqual([503, "payment_provider_unavailable"]);
    expect((await cancel(A.id, A.staff, id)).json.checkout.state).toBe("canceled");
    // The same key again is a replay: phase 1 does not run, so phase 2 checks.
    const replay = await testPay(A.id, A.staff, id, "succeed", pKey);
    expect([replay.status, replay.json.error?.code]).toEqual([409, "checkout_not_open"]);
    const [state] = await admin<{ events: number; refunds: number; state: string }[]>`
      select (select count(*)::int from public.fake_provider_events e
                join public.payments p on p.provider_payment_id = e.payment_id
               where p.checkout_session_id = ${id}) as events,
             (select count(*)::int from public.payment_refunds r
                join public.payments p on p.id = r.payment_id
               where p.checkout_session_id = ${id}) as refunds,
             (select state from public.checkout_sessions where id = ${id}) as state`;
    expect(state).toEqual({ events: 0, refunds: 0, state: "canceled" });
  });

  it("refuses the other outcome once a test payment settled, and keeps the record true", async () => {
    let calls = 0;
    const flakyApp = createApp({
      accessVerifier: verifier,
      deliverEmailAfterCommit: false,
      bookingHooks: {
        bookingConfirmed: async () => {
          calls += 1;
          if (calls === 1) throw new Error("injected: the first delivery fails");
        },
      },
    });
    const tripId = tripsA.shared();
    const q = await staffQuote(A, A.staff, tickets(tripId, 1));
    const opened = await open(A.id, A.staff, openBody(q, booker("opposite")));
    const id = opened.json.checkout.id as string;
    const pKey = key("opposite");
    const paid = await testPay(A.id, A.staff, id, "succeed", pKey, flakyApp);
    expect(paid.json.delivery.status).toBeGreaterThanOrEqual(500);
    // Decline under a new key: refused, recording nothing, delivering nothing.
    const declined = await testPay(A.id, A.staff, id, "fail", key("decline"), flakyApp);
    expect([declined.status, declined.json.error?.code]).toEqual([409, "test_payment_settled"]);
    const asked = await admin<{ outcome: string }[]>`
      select after_state ->> 'outcome' as outcome from public.audit_events
       where subject_id = ${id} and action = 'checkout.test_payment_requested'`;
    expect(asked.map((a) => a.outcome)).toEqual(["succeed"]);
    expect((await read(A.id, A.staff, id)).json.checkout.lastTestPayment.outcome).toBe("succeed");
    // The original key still delivers the payment that went through.
    const retry = await testPay(A.id, A.staff, id, "succeed", pKey, flakyApp);
    expect(retry.json.delivery).toMatchObject({ status: 200, outcome: "confirmed" });
  });

  it("lets one of two opposite test payments sent at once stand, and records the other as superseded", async () => {
    for (let round = 0; round < 4; round++) {
      const tripId = tripsA.shared();
      const q = await staffQuote(A, A.owner, tickets(tripId, 1));
      const opened = await open(A.id, A.owner, openBody(q, booker("both")));
      const id = opened.json.checkout.id as string;
      const [yes, no] = await Promise.all([
        testPay(A.id, A.owner, id, "succeed"),
        testPay(A.id, A.owner, id, "fail"),
      ]);
      const won = yes.status === 200 ? "succeed" : "fail";
      const lost = won === "succeed" ? no : yes;
      expect([yes.status, no.status].sort()).toEqual([200, 409]);
      expect(lost.json.error?.code).toBe("test_payment_settled");
      const now = (await read(A.id, A.owner, id)).json.checkout;
      expect(now.lastTestPayment.outcome).toBe(won);
      expect(now.state).toBe(won === "succeed" ? "confirmed" : "failed");
    }
  });

  // Acceptance 14 ----------------------------------------------------------------------------

  it("holds a staff member to the open-checkout limit, and colleagues apart", async () => {
    const limited = await member(
      A.id,
      `g212d-a-limited-${A.id.slice(0, 8)}@example.test`,
      "booking_staff",
      "active",
      "Lim Ited",
    );
    const email = `g212d-a-limited-${A.id.slice(0, 8)}@example.test`;
    expect(limited).toBeTruthy();
    const tripId = tripsA.shared();
    for (let i = 0; i < MAX_OPEN_CHECKOUTS_PER_CLIENT; i++) {
      const q = await staffQuote(A, email, tickets(tripId, 1));
      expect((await open(A.id, email, openBody(q, booker("cap")))).status).toBe(201);
    }
    const q = await staffQuote(A, email, tickets(tripId, 1));
    const refused = await open(A.id, email, openBody(q, booker("cap")));
    expect([refused.status, refused.json.error?.code]).toEqual([429, "too_many_checkouts"]);
    const colleague = await staffQuote(A, A.owner, tickets(tripId, 1));
    expect((await open(A.id, A.owner, openBody(colleague, booker("cap")))).status).toBe(201);
  });

  // Acceptance 15 ----------------------------------------------------------------------------

  it("keeps booker data out of every audit and outbox row, and records the staff member on pay and cancel", async () => {
    const audit = await admin<
      {
        action: string;
        actor_type: string;
        actor_id: string | null;
        reason: string | null;
        before: unknown;
        after: unknown;
      }[]
    >`
      select action, actor_type, actor_id, reason, before_state as before, after_state as after
        from public.audit_events where tenant_id in (${A.id}, ${B.id})
         and split_part(action, '.', 1) in ('checkout', 'booking', 'payment', 'quote', 'hold')`;
    const outbox = await admin<{ payload: unknown }[]>`
      select payload from public.outbox_events where tenant_id in (${A.id}, ${B.id})
         and split_part(topic, '.', 1) in ('checkout', 'booking', 'payment', 'quote', 'hold')`;
    const text = JSON.stringify([audit, outbox]).toLowerCase();
    expect(personal.length).toBeGreaterThan(10);
    for (const fragment of personal) expect(text, fragment).not.toContain(fragment.toLowerCase());
    for (const k of ["booker", "bookerName", "bookerEmail", "email"]) {
      expect(keysOf(audit.map((a) => [a.before, a.after])).has(k)).toBe(false);
      expect(keysOf(outbox.map((o) => o.payload)).has(k)).toBe(false);
    }
    const staffIds = new Set([A.staffId, A.ownerId, B.staffId, B.ownerId]);
    const requested = audit.filter((a) => a.action === "checkout.test_payment_requested");
    expect(requested.length).toBeGreaterThan(5);
    for (const a of requested) {
      expect(a.actor_type).toBe("staff");
      expect(staffIds.has(a.actor_id ?? "")).toBe(true);
    }
    const canceled = audit.filter(
      (a) => a.action === "checkout.session_canceled" && a.reason === "checkout canceled by staff",
    );
    expect(canceled.length).toBeGreaterThan(2);
    for (const a of canceled) expect(a.actor_type).toBe("staff");
  });
});
