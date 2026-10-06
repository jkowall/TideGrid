/**
 * Synthetic demo bookings (G2.12b), off by default: SEED_DEMO_BOOKINGS=1.
 *
 * Without bookings the console's booking views start empty. With the flag,
 * each demo operator gets a handful: two shared-seat bookings on its earliest
 * bookable departure (one with extras, one with the promotion code), a private
 * charter, and a late payment that could not be honored, refunded in full,
 * which raises a finalization exception.
 *
 * Every one goes the way a guest's does: a quote through the pricing service,
 * a checkout through the checkout service with its hold and immutable order,
 * the payment at the fake provider, then the provider's signed event, verified
 * and handed to the same `handleVerifiedEvent` the webhook route calls. No
 * booking, order, payment, or refund row is written here, so every trigger of
 * the chain of custody applies. The late payment is late for real: its
 * checkout is opened with the shortest hold the service allows (one minute),
 * the seed waits for it to run out, and another guest takes the boat first.
 *
 * Idempotent. A scenario whose booker already has a confirmed (or, for the
 * late payment, refunded) checkout at that operator is skipped. Bookers are
 * synthetic, at reserved `.test` addresses; the trips are whatever is
 * bookable when the seed runs.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  createCheckoutSession,
  ensureProviderPayment,
  handleVerifiedEvent,
} from "@tidegrid/domain-booking";
import { createFakePaymentProvider, type FakePaymentProvider } from "@tidegrid/domain-payments";
import { createQuote } from "@tidegrid/domain-pricing";
import type postgres from "postgres";

type Db = ReturnType<typeof createDb>["db"];
type Party =
  | { kind: "tickets"; tickets: { code: string; quantity: number }[] }
  | { kind: "charter"; guests: number };

interface Order {
  booker: { name: string; email: string };
  party: Party;
  addOns: { code: string; quantity: number }[];
  promotionCode?: string;
}

interface Plan {
  shared: { product: string; family: Order; discounted: Order };
  charter: { product: string; winner: Order; late: Order };
}

const guest = (slug: string, name: string) => ({
  name,
  email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@guests.${slug}.test`,
});

const plans: Record<string, Plan> = {
  "demo-harbor": {
    shared: {
      product: "Sunset Harbor Cruise",
      family: {
        booker: guest("demo-harbor", "Maya Lindqvist"),
        party: {
          kind: "tickets",
          tickets: [
            { code: "adult", quantity: 2 },
            { code: "child", quantity: 1 },
          ],
        },
        addOns: [
          { code: "photo", quantity: 1 },
          { code: "drinks", quantity: 3 },
        ],
      },
      discounted: {
        booker: guest("demo-harbor", "Theo Okafor"),
        party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
        addOns: [],
        promotionCode: "HARBOR10",
      },
    },
    charter: {
      product: "Private Half-Day Charter",
      winner: {
        booker: guest("demo-harbor", "Iris Calder"),
        party: { kind: "charter", guests: 8 },
        addOns: [{ code: "lunch", quantity: 8 }],
      },
      late: {
        booker: guest("demo-harbor", "Rafael Mendes"),
        party: { kind: "charter", guests: 6 },
        addOns: [],
      },
    },
  },
  "demo-reef": {
    shared: {
      product: "Afternoon Snorkel Sail",
      family: {
        booker: guest("demo-reef", "Keala Brooks"),
        party: {
          kind: "tickets",
          tickets: [
            { code: "adult", quantity: 2 },
            { code: "child", quantity: 2 },
          ],
        },
        addOns: [
          { code: "snorkel_set", quantity: 2 },
          { code: "sunscreen", quantity: 1 },
        ],
      },
      discounted: {
        booker: guest("demo-reef", "Noah Park"),
        party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
        addOns: [],
        promotionCode: "REEF25",
      },
    },
    charter: {
      product: "Private Dive Charter",
      winner: {
        booker: guest("demo-reef", "Lena Ortiz"),
        party: { kind: "charter", guests: 4 },
        addOns: [{ code: "photographer", quantity: 1 }],
      },
      late: {
        booker: guest("demo-reef", "Sam Whitaker"),
        party: { kind: "charter", guests: 3 },
        addOns: [],
      },
    },
  },
};

/** The shortest hold the checkout service allows, for the late payment. */
const LATE_HOLD_SECONDS = 60;
/** Candidate departures tried per product before giving up. */
const CANDIDATES = 12;

const guestContext = (tenantId: string): TenantContext => ({
  tenantId,
  actorType: "guest",
  actorId: null,
  requestId: `seed-${randomUUID()}`,
  sourceIp: null,
});

interface Opened {
  sessionId: string;
  paymentRef: string;
  tripId: string;
}

class Seeder {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly db: Db,
    private readonly provider: FakePaymentProvider,
    private readonly tenantId: string,
    private readonly slug: string,
  ) {}

  /** The latest checkout state a seeded booker has at this operator, or null. */
  async stateOf(order: Order): Promise<string | null> {
    const [row] = await this.sql<{ state: string }[]>`
      select state from public.checkout_sessions
       where tenant_id = ${this.tenantId} and booker_email = ${order.booker.email}
       order by created_at desc limit 1`;
    return row?.state ?? null;
  }

  /**
   * Departures of a product that the service may still sell, earliest first.
   * A charter must have its boat free of any hold. The pricing service has
   * the last word: a candidate it will not quote is skipped.
   */
  async candidates(product: string, freeBoat: boolean): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      select t.id
        from public.scheduled_trips t
        join public.products p on p.tenant_id = t.tenant_id and p.id = t.product_id
       where t.tenant_id = ${this.tenantId} and p.name = ${product}
         and t.sales_state = 'published'
         and t.starts_at > now() + make_interval(mins => p.booking_cutoff_minutes + 30)
         and (not ${freeBoat} or not exists (
               select 1 from public.capacity_holds h
                where h.tenant_id = t.tenant_id and h.trip_id = t.id
                  and (h.state = 'confirmed' or (h.state = 'active' and h.expires_at > now()))))
       order by t.starts_at
       limit ${CANDIDATES}`;
    return rows.map((r) => r.id);
  }

  /** A quote, a checkout with its hold and order, and the provider's payment. */
  async open(tripId: string, order: Order, ttlSeconds?: number): Promise<Opened | null> {
    const ctx = guestContext(this.tenantId);
    const sessionId = await inTenantTransaction(this.db, ctx, async (trx) => {
      const quoted = await createQuote(trx, ctx, {
        tripId,
        party: order.party,
        addOns: order.addOns,
        promotionCode: order.promotionCode ?? null,
        now: new Date(),
      });
      if (quoted.kind !== "created") return null;
      const created = await createCheckoutSession(trx, ctx, {
        quoteId: quoted.quote.quoteId,
        acceptedPolicyVersion: quoted.quote.policy.version,
        booker: order.booker,
        secret: randomBytes(32).toString("base64url"),
        clientAddress: null,
        provider: this.provider.name,
        minimumAmount: this.provider.minimumAmount("USD"),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      return created.kind === "created" ? created.session.id : null;
    });
    if (!sessionId) return null;
    const ready = await ensureProviderPayment(this.db, this.provider, ctx, sessionId);
    if (ready.kind !== "ready") {
      throw new Error(`${this.slug}: the fake provider did not take a payment (${ready.kind})`);
    }
    return { sessionId, paymentRef: ready.paymentRef, tripId };
  }

  /** The first candidate departure that takes the order. */
  async openOnFirst(trips: readonly string[], order: Order, ttlSeconds?: number) {
    for (const tripId of trips) {
      const opened = await this.open(tripId, order, ttlSeconds);
      if (opened) return opened;
    }
    throw new Error(`${this.slug}: no bookable departure took ${order.booker.name}'s party`);
  }

  /**
   * The guest pays: the fake settles the payment and stores its event, which
   * is signed, verified, and handled exactly as the webhook route does.
   */
  async pay(opened: Opened): Promise<string> {
    const settled = await this.provider.settlePayment(
      this.tenantId,
      opened.paymentRef,
      "succeeded",
      Date.now(),
    );
    if (settled.kind === "not_found") throw new Error(`${this.slug}: payment vanished`);
    const now = Date.now();
    const signature = await this.provider.signDelivery(settled.event.body, now);
    const verified = await this.provider.verifyWebhook({
      rawBody: settled.event.body,
      signatureHeader: signature.value,
      nowMs: now,
    });
    if (verified.kind !== "verified") throw new Error(`${this.slug}: event did not verify`);
    const handled = await handleVerifiedEvent(this.db, this.provider, verified.event, {
      requestId: `seed-${randomUUID()}`,
      sourceIp: null,
    });
    if (handled.kind !== "processed") throw new Error(`${this.slug}: event ${handled.kind}`);
    return handled.outcome;
  }
}

/** Seconds until every given checkout's hold has run out, by the database clock. */
async function secondsUntilLapsed(sql: postgres.Sql, sessionIds: readonly string[]) {
  if (sessionIds.length === 0) return 0;
  const [row] = await sql<{ wait: number }[]>`
    select coalesce(ceil(extract(epoch from max(expires_at) - now())), 0)::int as wait
      from public.checkout_sessions where id in ${sql(sessionIds)}`;
  return Math.max(0, row?.wait ?? 0);
}

export async function seedDemoBookings(
  url: string,
  sql: postgres.Sql,
  tenants: readonly { id: string; slug: string }[],
): Promise<void> {
  const { db, end } = createDb(url, { max: 2 });
  // The seed signs and verifies its own deliveries, so any secret of the
  // provider's minimum length works; it never leaves this process.
  const provider = createFakePaymentProvider({
    db,
    secret: process.env.FAKE_PAYMENT_WEBHOOK_SECRET ?? randomBytes(32).toString("hex"),
    environment: "local",
  });
  try {
    const late: { seeder: Seeder; plan: Plan; opened: Opened }[] = [];
    for (const tenant of tenants) {
      const plan = plans[tenant.slug];
      if (!plan) continue;
      const seeder = new Seeder(sql, db, provider, tenant.id, tenant.slug);
      const made: string[] = [];

      // Two shared-seat bookings on the earliest departure that takes them.
      const shared = await seeder.candidates(plan.shared.product, false);
      for (const order of [plan.shared.family, plan.shared.discounted]) {
        if ((await seeder.stateOf(order)) === "confirmed") continue;
        const opened = await seeder.openOnFirst(shared, order);
        const outcome = await seeder.pay(opened);
        if (outcome !== "confirmed")
          throw new Error(`${tenant.slug}: ${order.booker.name} ${outcome}`);
        made.push(order.booker.name);
      }

      // The charter and the late payment run together: the late guest's
      // checkout lapses, the other guest takes the boat, then the late
      // payment arrives and is refunded.
      const done =
        (await seeder.stateOf(plan.charter.winner)) === "confirmed" &&
        (await seeder.stateOf(plan.charter.late)) === "unfulfilled";
      if (!done) {
        const charters = await seeder.candidates(plan.charter.product, true);
        const opened = await seeder.openOnFirst(charters, plan.charter.late, LATE_HOLD_SECONDS);
        late.push({ seeder, plan, opened });
      }
      console.log(
        `seeded demo bookings for ${tenant.slug}: ${made.length ? made.join(", ") : "shared-seat bookings already present"}${
          done ? "; the charter and the late payment already present" : ""
        }`,
      );
    }

    if (late.length > 0) {
      const wait = await secondsUntilLapsed(
        sql,
        late.map((l) => l.opened.sessionId),
      );
      console.log(`waiting ${wait + 2} s for the late checkouts' holds to run out`);
      await new Promise((resolve) => setTimeout(resolve, (wait + 2) * 1000));
      for (const { seeder, plan, opened } of late) {
        // Another guest takes the boat; their acquisition expires the lapsed hold.
        const winner = await seeder.open(opened.tripId, plan.charter.winner);
        if (!winner) throw new Error(`${plan.charter.product}: the boat could not be taken`);
        const refunded = await seeder.pay(opened);
        if (refunded !== "refund_required") {
          throw new Error(`${plan.charter.product}: the late payment came back ${refunded}`);
        }
        const confirmed = await seeder.pay(winner);
        if (confirmed !== "confirmed") {
          throw new Error(`${plan.charter.product}: the charter came back ${confirmed}`);
        }
      }
      console.log(
        `seeded ${late.length} private charter(s) and ${late.length} refunded late payment(s) with their exceptions`,
      );
    }
  } finally {
    await end();
  }
}
