/**
 * Integration-test fixtures for checkout (Node only; exported as
 * `@tidegrid/domain-booking/testing`). A tenant comes from the inventory
 * fixture, built through the real catalog and pricing services, and gains a
 * fake connected account, tax rates, and a promotion, so quotes and orders
 * carry every kind of line. Events are produced the only way the system
 * accepts them: signed by the fake provider and verified.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  createTenantFixture,
  systemContext,
  type TenantFixture,
} from "@tidegrid/domain-inventory/testing";
import {
  createFakePaymentProvider,
  type FakePaymentProvider,
  type VerifiedProviderEvent,
} from "@tidegrid/domain-payments";
import { createPromotion, createQuote, createTaxRate } from "@tidegrid/domain-pricing";
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof createDb>["db"];

/** A fixed test secret; the fake provider refuses anything shorter than 32 characters. */
export const TEST_FAKE_SECRET = "g27-test-fake-provider-secret-0123456789abcdef";

export interface CheckoutFixture extends TenantFixture {
  accountRef: string;
  taxRateId: string;
  promotionCode: string;
}

/** A guest's capability secret: 32 random bytes, base64url. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function guestContext(tenantId: string): TenantContext {
  return {
    tenantId,
    actorType: "guest",
    actorId: null,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  };
}

export function fakeProvider(db: Db, secret = TEST_FAKE_SECRET): FakePaymentProvider {
  return createFakePaymentProvider({ db, secret, environment: "local" });
}

/**
 * A tenant with trips (see the inventory fixture), an active fake connected
 * account, a 7% added tax, and a 10% promotion code.
 */
export async function createCheckoutFixture(
  admin: Sql,
  db: Db,
  label: string,
  options: { days?: number } = {},
): Promise<CheckoutFixture> {
  const tenant = await createTenantFixture(admin, db, label, options);
  const accountRef = `acct_fake_${tenant.slug}`.slice(0, 69);
  await admin`insert into public.payment_accounts (tenant_id, provider, account_ref)
    values (${tenant.id}, 'fake', ${accountRef})`;
  const ctx = systemContext(tenant.id, "fixture");
  const promotionCode = `SAVE${tenant.id.slice(0, 4).toUpperCase()}`;
  const taxRateId = await inTenantTransaction(db, ctx, async (trx) => {
    const tax = await createTaxRate(trx, ctx, {
      name: "Fixture sales tax",
      ratePpm: 70_000,
      inclusive: false,
      reason: "fixture",
    });
    if (tax.kind !== "created") throw new Error(`fixture tax: ${JSON.stringify(tax)}`);
    const promo = await createPromotion(trx, ctx, {
      code: promotionCode,
      discount: { kind: "percent", percentOffBp: 1000 },
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 365 * 86_400_000),
      products: { all: true },
      reason: "fixture",
    });
    if (promo.kind !== "created") throw new Error(`fixture promotion: ${JSON.stringify(promo)}`);
    return tax.taxRateId;
  });
  return { ...tenant, accountRef, taxRateId, promotionCode };
}

/** A fresh quote through the real pricing service: adults on a shared trip, or a charter. */
export async function quoteFor(
  db: Db,
  tenantId: string,
  tripId: string,
  party: number,
  options: { charter?: boolean; promotionCode?: string | null; now?: Date } = {},
) {
  const ctx = guestContext(tenantId);
  const created = await inTenantTransaction(db, ctx, (trx) =>
    createQuote(trx, ctx, {
      tripId,
      party: options.charter
        ? { kind: "charter", guests: party }
        : { kind: "tickets", tickets: [{ code: "adult", quantity: party }] },
      addOns: [],
      promotionCode: options.promotionCode ?? null,
      now: options.now ?? new Date(),
    }),
  );
  if (created.kind !== "created") throw new Error(`quote: ${JSON.stringify(created)}`);
  return created.quote;
}

/**
 * Sign a fake event body and verify it, as the webhook route does. Throws if
 * verification fails, so a test cannot pass an unverified event by accident.
 */
export async function verifiedFakeEvent(
  provider: FakePaymentProvider,
  body: string,
  nowMs = Date.now(),
): Promise<VerifiedProviderEvent> {
  const signature = await provider.signDelivery(body, nowMs);
  const checked = await provider.verifyWebhook({
    rawBody: body,
    signatureHeader: signature.value,
    nowMs,
  });
  if (checked.kind !== "verified") throw new Error(`event did not verify: ${checked.reason}`);
  return checked.event;
}

/**
 * A fake event body for any payment, as a misbehaving or reordering provider
 * might send it: used to deliver a failure after a success, or an event with
 * the wrong amount. Real fake payments settle once; these bodies are signed
 * the same way and pass verification.
 */
export function craftedFakeEventBody(input: {
  type: "payment.succeeded" | "payment.failed" | string;
  accountRef: string;
  paymentRef: string;
  amount: number;
  clientReference: string | null;
  eventId?: string;
  createdMs?: number;
}): string {
  const suffix = randomBytes(18)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .padEnd(24, "x")
    .slice(0, 24);
  return JSON.stringify({
    id: input.eventId ?? `fevt_${suffix}`,
    object: "event",
    type: input.type,
    created: Math.floor((input.createdMs ?? Date.now()) / 1000),
    account: input.accountRef,
    data: {
      object: {
        id: input.paymentRef,
        object: "payment",
        amount: input.amount,
        currency: "usd",
        status: input.type === "payment.succeeded" ? "succeeded" : "failed",
        client_reference: input.clientReference,
      },
    },
  });
}

/**
 * Make time pass for one checkout: move its expiry and its hold's expiry
 * earlier together, as the database allows. Admin only; never later.
 */
export async function backdateCheckout(admin: Sql, sessionId: string, seconds = 1): Promise<void> {
  const rows = await admin`
    with s as (
      update public.checkout_sessions
         set expires_at = least(expires_at, now() - make_interval(secs => ${seconds}))
       where id = ${sessionId}
      returning hold_id, expires_at)
    update public.capacity_holds h
       set expires_at = least(h.expires_at, s.expires_at)
      from s
     where h.id = s.hold_id
    returning h.id`;
  if (rows.length !== 1) throw new Error(`no checkout ${sessionId} to backdate`);
}
