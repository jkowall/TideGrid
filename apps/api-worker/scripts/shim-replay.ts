/**
 * Shim replay evidence (G2.7). Drives a running API (wrangler dev) through the
 * fake payment provider and its real webhook route, and records the database
 * state before and after every step: delivery, duplicate delivery, an exact
 * replay of a signed request, a stale signature, events out of order, and late
 * successes with and without capacity. It stands in for Stripe CLI replay
 * evidence, as the demo build plan records.
 *
 *   API_URL=http://localhost:8847 \
 *   ORIGIN=https://demo-harbor.book.tidegrid.us \
 *   ADMIN_DATABASE_URL=<admin URL of the throwaway branch the API uses> \
 *   FAKE_PAYMENT_WEBHOOK_SECRET=<the API's fake webhook secret> \
 *   OUT=<file for the step log> \
 *   pnpm --filter @tidegrid/api-worker exec tsx scripts/shim-replay.ts
 *
 * The admin connection reads state and makes time pass by moving expiries
 * earlier, as the integration tests do. Never point it at the main branch.
 * It prints identifiers and states only, never secrets or booker details.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { signatureHeaderValue } from "@tidegrid/domain-payments";
import postgres from "postgres";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

const api = process.env.API_URL ?? "http://localhost:8847";
const origin = process.env.ORIGIN ?? "https://demo-harbor.book.tidegrid.us";
const secret = required("FAKE_PAYMENT_WEBHOOK_SECRET");
const sql = postgres(required("ADMIN_DATABASE_URL"), { max: 1, onnotice: () => {} });
const lines: string[] = [];

function log(line = ""): void {
  console.log(line);
  lines.push(line);
}

type Json = Record<string, unknown>;

async function call(
  method: string,
  path: string,
  options: {
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
    origin?: boolean;
  } = {},
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.origin !== false) headers.origin = origin;
  if (options.body !== undefined || options.raw !== undefined) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    body: options.raw ?? (options.body === undefined ? null : JSON.stringify(options.body)),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

function fakeEventId(): string {
  return `fevt_${randomBytes(32)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 24)}`;
}

interface Checkout {
  sessionId: string;
  secret: string;
  paymentRef: string;
  clientSecret: string;
  tripId: string;
  amount: number;
}

async function findTrip(kind: "shared_seat" | "private_charter", party: number, skip: string[]) {
  for (let offset = 3; offset < 60; offset += 7) {
    const from = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + (offset + 6) * 86_400_000).toISOString().slice(0, 10);
    const { json } = await call("GET", `/v1/public/trips?from=${from}&to=${to}&party=${party}`);
    const trips = (json.trips ?? []) as { tripId: string; product: { kind: string } }[];
    const found = trips.find((t) => t.product.kind === kind && !skip.includes(t.tripId));
    if (found) return found.tripId;
  }
  throw new Error(`no ${kind} trip on sale for a party of ${party}`);
}

async function open(tripId: string, party: number, charter: boolean): Promise<Checkout> {
  const offer = await call("GET", `/v1/public/trips/${tripId}/offer`);
  const tickets = ((offer.json.offer as Json)?.tickets ?? []) as { code: string }[];
  // One add-on when the trip offers any, so the order carries every kind of line.
  const addOns = ((offer.json.offer as Json)?.addOns ?? []) as { code: string }[];
  const quote1 = (promotionCode: string | undefined) =>
    call("POST", "/v1/public/quotes", {
      headers: { "idempotency-key": `shim-q-${randomUUID()}` },
      body: {
        tripId,
        party: charter
          ? { kind: "charter", guests: party }
          : { kind: "tickets", tickets: [{ code: tickets[0]?.code ?? "adult", quantity: party }] },
        addOns: addOns[0] ? [{ code: addOns[0].code, quantity: 1 }] : [],
        ...(promotionCode ? { promotionCode } : {}),
      },
    });
  let quoted = await quote1(process.env.PROMOTION_CODE);
  // A code that does not cover this product: quote without it.
  if ((quoted.json.error as Json | undefined)?.code === "promotion_not_applicable") {
    quoted = await quote1(undefined);
  }
  if (quoted.status !== 201)
    throw new Error(`quote ${quoted.status} ${JSON.stringify(quoted.json)}`);
  const quote = quoted.json.quote as { quoteId: string; policy: { version: number } };
  const checkoutSecret = randomBytes(32).toString("base64url");
  const opened = await call("POST", "/v1/public/checkout-sessions", {
    headers: { "idempotency-key": `shim-c-${randomUUID()}` },
    body: {
      quoteId: quote.quoteId,
      acceptedPolicyVersion: quote.policy.version,
      booker: { name: "Shim Replay Guest", email: "shim.replay@example.test" },
      checkoutSecret,
    },
  });
  if (opened.status !== 201) {
    throw new Error(`checkout ${opened.status} ${JSON.stringify(opened.json)}`);
  }
  const session = opened.json.checkoutSession as { id: string; amount: number };
  const payment = opened.json.payment as { paymentRef: string; clientSecret: string };
  return {
    sessionId: session.id,
    secret: checkoutSecret,
    paymentRef: payment.paymentRef,
    clientSecret: payment.clientSecret,
    tripId,
    amount: session.amount,
  };
}

const control = (c: Checkout, action: string, body?: unknown) =>
  call("POST", `/v1/fake-provider/payments/${c.paymentRef}/${action}`, {
    headers: { authorization: `Bearer ${c.clientSecret}` },
    ...(body === undefined ? {} : { body }),
  });

const guestState = async (c: Checkout) =>
  (
    await call("GET", `/v1/public/checkout-sessions/${c.sessionId}`, {
      headers: { authorization: `Bearer ${c.secret}` },
    })
  ).json.checkoutSession as { state: string; booking: unknown; refund: unknown };

/** Post a body to the webhook exactly as the provider would, with a chosen signing time. */
async function webhook(body: string, signedAtMs = Date.now(), header?: string) {
  const signature = header ?? (await signatureHeaderValue(secret, signedAtMs, body));
  const res = await call("POST", "/v1/webhooks/payments/fake", {
    raw: body,
    origin: false,
    headers: { "fake-signature": signature },
  });
  return { ...res, signature };
}

async function snapshot(c: Checkout): Promise<string> {
  const [row] = await sql<
    {
      session: string;
      hold: string;
      order: string;
      payment: string;
      bookings: number;
      refund: string | null;
      exception: string | null;
      inbox: string | null;
      held: number;
      confirmed: number;
      fake: string;
    }[]
  >`
    select s.state as session, h.state as hold, o.status as order, p.state as payment,
           (select count(*)::int from public.bookings b where b.checkout_session_id = s.id) as bookings,
           (select r.state from public.payment_refunds r where r.payment_id = p.id) as refund,
           (select string_agg(e.reason, ',') from public.finalization_exceptions e
             where e.checkout_session_id = s.id) as exception,
           (select string_agg(coalesce(i.outcome, i.processing_state), ',' order by i.verified_at)
              from public.provider_events i where i.payment_ref = p.provider_payment_id) as inbox,
           u.held, u.confirmed,
           coalesce((select f.type from public.fake_provider_events f
                      where f.payment_id = p.provider_payment_id), 'pending') as fake
      from public.checkout_sessions s
      join public.capacity_holds h on h.id = s.hold_id
      join public.orders o on o.checkout_session_id = s.id
      join public.payments p on p.checkout_session_id = s.id
      cross join lateral app.trip_capacity_usage(s.tenant_id, s.trip_id) u
     where s.id = ${c.sessionId}`;
  if (!row) throw new Error("no checkout");
  return [
    `checkout=${row.session}`,
    `hold=${row.hold}`,
    `order=${row.order}`,
    `payment=${row.payment}`,
    `bookings=${row.bookings}`,
    `refund=${row.refund ?? "none"}`,
    `exception=${row.exception ?? "none"}`,
    `inbox=[${row.inbox ?? ""}]`,
    `trip held/confirmed=${row.held}/${row.confirmed}`,
    `fake=${row.fake}`,
  ].join(" ");
}

async function step(c: Checkout, label: string, action: () => Promise<string>) {
  const before = await snapshot(c);
  const result = await action();
  const after = await snapshot(c);
  log(`- ${label}`);
  log(`  - result: ${result}`);
  log(`  - before: ${before}`);
  log(`  - after:  ${after}`);
}

/** The order's lines as kind:amount, and its total against the payment's amount. */
async function orderSummary(c: Checkout): Promise<string> {
  const lines = await sql<{ kind: string; amount: number; tax_inclusive: boolean | null }[]>`
    select l.kind, l.amount, l.tax_inclusive from public.order_lines l
      join public.orders o on o.id = l.order_id
     where o.checkout_session_id = ${c.sessionId}
     order by l.line_no`;
  const [totals] = await sql<{ total: number; included: number; charged: number }[]>`
    select o.total_amount as total, o.included_tax_amount as included, p.amount as charged
      from public.orders o join public.payments p on p.order_id = o.id
     where o.checkout_session_id = ${c.sessionId}`;
  const shown = lines.map((l) => `${l.kind}${l.tax_inclusive ? " (included)" : ""} ${l.amount}`);
  return `order lines [${shown.join(", ")}]; total ${totals?.total}, included tax ${totals?.included}, charged ${totals?.charged}`;
}

async function backdate(c: Checkout): Promise<void> {
  await sql`
    with s as (update public.checkout_sessions set expires_at = now() - interval '1 second'
                where id = ${c.sessionId} returning hold_id)
    update public.capacity_holds h set expires_at = now() - interval '1 second'
      from s where h.id = s.hold_id`;
}

async function storedBody(eventId: string): Promise<string> {
  const [row] = await sql<{ body: string }[]>`
    select body from public.fake_provider_events where id = ${eventId}`;
  if (!row) throw new Error("no stored event");
  return row.body;
}

const show = (r: { status: number; json: Json }) => {
  const delivery = r.json.delivery as Json | null | undefined;
  if (delivery)
    return `HTTP ${r.status}; webhook ${delivery.status} ${delivery.outcome} duplicate=${delivery.duplicate}`;
  if (r.json.error) return `HTTP ${r.status} ${(r.json.error as Json).code}`;
  if ("outcome" in r.json)
    return `HTTP ${r.status} outcome=${r.json.outcome} duplicate=${r.json.duplicate}`;
  return `HTTP ${r.status}`;
};

async function main(): Promise<void> {
  log(
    `Shim replay against ${api}, origin ${new URL(origin).hostname}, ${new Date().toISOString()}`,
  );
  const used: string[] = [];

  log("");
  log("1. Deliver, duplicate, exact replay, stale signature, and a failure after the success");
  const sharedTrip = await findTrip("shared_seat", 2, used);
  used.push(sharedTrip);
  const one = await open(sharedTrip, 2, false);
  log(`- opened: ${await orderSummary(one)}`);
  let heldEvent = "";
  await step(
    one,
    "the guest pays; the fake records the success and holds the event back",
    async () => {
      const r = await control(one, "succeed", { deliver: false });
      heldEvent = (r.json.event as { id: string }).id;
      return `${show(r)}; no webhook yet, and the control alone changes nothing in TideGrid`;
    },
  );
  await step(one, "the fake delivers the signed event", async () =>
    show(await control(one, `events/${heldEvent}/redeliver`)),
  );
  await step(one, "the fake delivers the same event again (a provider retry)", async () =>
    show(await control(one, `events/${heldEvent}/redeliver`)),
  );
  const body = await storedBody(heldEvent);
  let captured = "";
  await step(one, "the identical signed request is replayed twice inside the window", async () => {
    const first = await webhook(body);
    captured = first.signature;
    const second = await webhook(body, Date.now(), captured);
    return `${show(first)}; ${show(second)}`;
  });
  await step(one, "the same event signed ten minutes ago", async () =>
    show(await webhook(body, Date.now() - 600_000)),
  );
  await step(one, "the same body with one byte changed, under the captured signature", async () =>
    show(await webhook(body.replace('"usd"', '"usd" '), Date.now(), captured)),
  );
  const [ids] = await sql<{ id: string }[]>`
    select id from public.payments where checkout_session_id = ${one.sessionId}`;
  await step(
    one,
    "a failure for the same payment arrives after the success (out of order)",
    async () => {
      const failure = JSON.stringify({
        id: fakeEventId(),
        object: "event",
        type: "payment.failed",
        created: Math.floor(Date.now() / 1000) - 30,
        account: JSON.parse(body).account,
        data: {
          object: {
            id: one.paymentRef,
            object: "payment",
            amount: one.amount,
            currency: "usd",
            status: "failed",
            client_reference: ids?.id ?? null,
          },
        },
      });
      return show(await webhook(failure));
    },
  );
  log(`  - guest sees: ${JSON.stringify(await guestState(one))}`);

  log("");
  log("2. A late success while the seats are still free reacquires them");
  const lateTrip = await findTrip("shared_seat", 2, used);
  used.push(lateTrip);
  const two = await open(lateTrip, 2, false);
  let lateEvent = "";
  await step(two, "the guest pays; the event is held back", async () => {
    const r = await control(two, "succeed", { deliver: false });
    lateEvent = (r.json.event as { id: string }).id;
    return show(r);
  });
  await step(two, "time passes: the checkout and its hold expire", async () => {
    await backdate(two);
    return `guest sees ${(await guestState(two)).state}`;
  });
  await step(two, "the delayed event finally arrives", async () =>
    show(await control(two, `events/${lateEvent}/redeliver`)),
  );

  log("");
  log("3. A late success after someone else took the boat is refunded in full");
  const charterTrip = await findTrip("private_charter", 2, used);
  used.push(charterTrip);
  const three = await open(charterTrip, 2, true);
  log(`- opened: ${await orderSummary(three)}`);
  let charterEvent = "";
  await step(three, "the guest pays; the event is held back", async () => {
    const r = await control(three, "succeed", { deliver: false });
    charterEvent = (r.json.event as { id: string }).id;
    return show(r);
  });
  await step(three, "time passes: the checkout and its whole-boat hold expire", async () => {
    await backdate(three);
    return `guest sees ${(await guestState(three)).state}`;
  });
  let four: Checkout | null = null;
  await step(three, "another guest opens a checkout and takes the boat", async () => {
    four = await open(charterTrip, 3, true);
    return `second checkout ${(await guestState(four)).state}`;
  });
  await step(three, "the first guest's delayed success arrives", async () =>
    show(await control(three, `events/${charterEvent}/redeliver`)),
  );
  await step(three, "it arrives once more", async () =>
    show(await control(three, `events/${charterEvent}/redeliver`)),
  );
  log(`  - guest sees: ${JSON.stringify(await guestState(three))}`);
  if (four) {
    const second: Checkout = four;
    await step(second, "the second guest pays and keeps the boat", async () =>
      show(await control(second, "succeed")),
    );
  }

  log("");
  log("4. A failure releases the seats; a success that follows it is refunded, never booked");
  const failTrip = await findTrip("shared_seat", 1, used);
  used.push(failTrip);
  const five = await open(failTrip, 1, false);
  await step(five, "the payment fails", async () => show(await control(five, "fail")));
  const [fiveIds] = await sql<{ id: string; account: string }[]>`
    select id, account_ref as account from public.payments where checkout_session_id = ${five.sessionId}`;
  await step(five, "a success for the same payment arrives afterwards (out of order)", async () => {
    const success = JSON.stringify({
      id: fakeEventId(),
      object: "event",
      type: "payment.succeeded",
      created: Math.floor(Date.now() / 1000),
      account: fiveIds?.account,
      data: {
        object: {
          id: five.paymentRef,
          object: "payment",
          amount: five.amount,
          currency: "usd",
          status: "succeeded",
          client_reference: fiveIds?.id ?? null,
        },
      },
    });
    return show(await webhook(success));
  });

  const [totals] = await sql<
    { events: number; bookings: number; refunds: number; exceptions: number }[]
  >`
    select (select count(*)::int from public.provider_events) as events,
           (select count(*)::int from public.bookings) as bookings,
           (select count(*)::int from public.payment_refunds) as refunds,
           (select count(*)::int from public.finalization_exceptions) as exceptions`;
  log("");
  log(`Totals on the branch: ${JSON.stringify(totals)}`);
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
  if (process.env.OUT) writeFileSync(process.env.OUT, `${lines.join("\n")}\n`);
}
