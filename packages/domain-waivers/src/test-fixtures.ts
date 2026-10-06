/**
 * Integration-test fixtures for waivers (Node only; exported as
 * `@tidegrid/domain-waivers/testing`). A tenant comes from the checkout
 * fixture, built through the real catalog, pricing, and checkout services, and
 * gains an active guest hostname and an operator waiver template. Bookings are
 * made the only way the system makes them: a real checkout, the fake
 * provider's payment, and its verified event, with the waiver hooks on.
 * Participants are named through the booking module's own command, which
 * runs the hooks too. Email goes through the messaging module's real delivery
 * job and fake provider, so a test reads the link a guest would receive.
 */
import { randomUUID } from "node:crypto";
import { type createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import {
  type BookingHooks,
  createCheckoutSession,
  ensureProviderPayment,
  handleVerifiedEvent,
  type ParticipantDetails,
  type PutParticipantResult,
  putParticipant,
} from "@tidegrid/domain-booking";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "@tidegrid/domain-booking/testing";
import { deliverTenantMessages, FakeEmailProvider } from "@tidegrid/domain-messaging";
import { FAKE_MINIMUM_AMOUNT } from "@tidegrid/domain-payments";
import type postgres from "postgres";
import { createWaiverHooks } from "./hooks.ts";
import { defaultWaiverDeps } from "./participants.ts";
import type { WaiverDeps } from "./ports.ts";
import { createWaiverTemplate, publishWaiverTemplateVersion } from "./templates.ts";

type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof createDb>["db"];

export function staffContext(tenantId: string, actorId = "waiver-test"): TenantContext {
  return { tenantId, actorType: "system", actorId, requestId: `req-${randomUUID()}` };
}

export const FIXTURE_TEXT = {
  title: "Fixture participation waiver",
  body: "Synthetic fixture text. Not a real agreement.\n\nBoating has risks.\nFollow the crew.",
  acknowledgments: ["I have read this waiver.", "I accept the risks."],
};

/** The guest site a fixture tenant's links open: an active hostname of the tenant. */
export const FIXTURE_LINK_ORIGIN = "https://{slug}.book.example.test";
export const FIXTURE_FROM = "waivers@mail.example.test";

export interface WaiverFixture extends CheckoutFixture {
  templateId: string;
  /** The tenant's active guest hostname. */
  host: string;
}

/** A checkout-ready tenant with a guest hostname and an operator template at version 1. */
export async function createWaiverFixture(
  admin: Sql,
  db: Db,
  label: string,
  options: { days?: number } = {},
): Promise<WaiverFixture> {
  const tenant = await createCheckoutFixture(admin, db, label, options);
  const host = `${tenant.slug}.book.example.test`;
  await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
    values (${host}, ${tenant.id}, 'preview', 'active', now())`;
  const ctx = staffContext(tenant.id);
  const templateId = await inTenantTransaction(db, ctx, async (trx) => {
    const created = await createWaiverTemplate(trx, ctx, {
      scope: "operator",
      name: "Fixture waiver",
      reason: "fixture",
    });
    if (created.kind !== "created") throw new Error(`fixture template: ${JSON.stringify(created)}`);
    const published = await publishWaiverTemplateVersion(trx, ctx, null, {
      templateId: created.templateId,
      text: FIXTURE_TEXT,
      reason: "fixture",
    });
    if (published.kind !== "published") {
      throw new Error(`fixture version: ${JSON.stringify(published)}`);
    }
    return created.templateId;
  });
  return { ...tenant, templateId, host };
}

export function fixtureDeps(): WaiverDeps {
  return defaultWaiverDeps;
}

/** The waiver hooks, as the API wires them. */
export function fixtureHooks(): BookingHooks {
  return createWaiverHooks(defaultWaiverDeps);
}

export interface Booked {
  bookingId: string;
  reference: string;
  tripId: string;
  checkoutSessionId: string;
}

/** A confirmed booking for `party` adults on a shared trip, through the real checkout. */
export async function bookParty(
  admin: Sql,
  db: Db,
  tenant: CheckoutFixture,
  tripId: string,
  party: number,
  hooks: BookingHooks,
): Promise<Booked> {
  const provider = fakeProvider(db);
  const quote = await quoteFor(db, tenant.id, tripId, party);
  const ctx = guestContext(tenant.id);
  const created = await inTenantTransaction(db, ctx, (trx) =>
    createCheckoutSession(trx, ctx, {
      quoteId: quote.quoteId,
      acceptedPolicyVersion: quote.policy.version,
      booker: { name: "Synthetic Booker", email: "synthetic.booker@example.test" },
      secret: newSecret(),
      clientAddress: null,
      provider: "fake",
      minimumAmount: FAKE_MINIMUM_AMOUNT,
    }),
  );
  if (created.kind !== "created") throw new Error(`fixture checkout: ${JSON.stringify(created)}`);
  const ready = await ensureProviderPayment(db, provider, ctx, created.session.id);
  if (ready.kind !== "ready") throw new Error(`fixture payment: ${JSON.stringify(ready)}`);
  const settled = await provider.settlePayment(
    tenant.id,
    ready.paymentRef,
    "succeeded",
    Date.now(),
  );
  if (settled.kind === "not_found") throw new Error("fixture payment did not settle");
  const event = await verifiedFakeEvent(provider, settled.event.body);
  const handled = await handleVerifiedEvent(db, provider, event, {
    requestId: `wh-${randomUUID()}`,
    hooks,
  });
  if (handled.kind !== "processed" || handled.outcome !== "confirmed") {
    throw new Error(`fixture booking: ${JSON.stringify(handled)}`);
  }
  const [row] = await admin<{ id: string; reference: string }[]>`
    select id, reference from public.bookings where checkout_session_id = ${created.session.id}`;
  if (!row) throw new Error("fixture booking not found");
  return {
    bookingId: row.id,
    reference: row.reference,
    tripId,
    checkoutSessionId: created.session.id,
  };
}

/** Name or correct the participant at one place, as the guest's management link does. */
export async function nameParticipant(
  db: Db,
  tenantId: string,
  bookingId: string,
  position: number,
  details: ParticipantDetails,
  hooks: BookingHooks,
): Promise<Extract<PutParticipantResult, { participant: unknown }>> {
  const ctx = guestContext(tenantId);
  const put = await inTenantTransaction(db, ctx, (trx) =>
    putParticipant(trx, ctx, { bookingId, position, details }, hooks),
  );
  if (!("participant" in put)) throw new Error(`fixture participant: ${JSON.stringify(put)}`);
  return put;
}

/** An adult with their own address, or a minor with a guardian. */
export function adult(name: string, email?: string | null): ParticipantDetails {
  return {
    name,
    isMinor: false,
    email:
      email === undefined ? `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.test` : email,
  };
}

export function minor(name: string, guardian: { name: string; email: string }): ParticipantDetails {
  return { name, isMinor: true, email: null, guardian };
}

/** Send the tenant's due email through the real delivery job and the fake provider. */
export async function deliverMail(db: Db, tenantId: string): Promise<void> {
  await deliverTenantMessages(db, tenantId, {
    provider: new FakeEmailProvider({ db, environment: "local" }),
    fromAddress: FIXTURE_FROM,
    guestLinkOrigin: FIXTURE_LINK_ORIGIN,
    runId: `run-${randomUUID()}`,
    limit: 500,
  });
}

/**
 * Deliver the tenant's due email, then read the waiver link in the email that
 * the request's newest delivery generation sent, as the guest would.
 */
export async function linkFor(
  admin: Sql,
  db: Db,
  tenantId: string,
  requestId: string,
): Promise<{ link: string; token: string; to: string; subject: string; text: string }> {
  await deliverMail(db, tenantId);
  const [row] = await admin<{ state: string; provider_message_id: string | null }[]>`
    select m.state, m.provider_message_id
      from public.waiver_deliveries d
      join public.email_messages m on m.tenant_id = d.tenant_id and m.id = d.message_id
     where d.request_id = ${requestId}
     order by d.generation desc limit 1`;
  if (row?.state !== "sent" || !row.provider_message_id) {
    throw new Error(`waiver email for ${requestId} was not sent: ${JSON.stringify(row)}`);
  }
  const mail = await new FakeEmailProvider({ db, environment: "local" }).getMailboxMessage(
    tenantId,
    row.provider_message_id,
  );
  if (!mail) throw new Error("the fake mailbox has no such message");
  const link = /https:\/\/[^\s"<]+\/waiver#t=[A-Za-z0-9_-]{43}/.exec(mail.text)?.[0];
  if (!link) throw new Error("no waiver link in the email");
  return { link, token: tokenOf(link), to: mail.to, subject: mail.subject, text: mail.text };
}

/** The entry token in a link's fragment. */
export function tokenOf(link: string): string {
  const token = new URL(link).hash.match(/^#t=([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new Error(`no token in ${link}`);
  return token;
}
