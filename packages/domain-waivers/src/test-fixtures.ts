/**
 * Integration-test fixtures for waivers (Node only; exported as
 * `@tidegrid/domain-waivers/testing`). A tenant comes from the checkout
 * fixture, built through the real catalog, pricing, and checkout services, and
 * gains an operator waiver template. Bookings are made the only way the system
 * makes them: a real checkout, the fake provider's payment, and its verified
 * event, with the waiver hooks on. Participants are named through the booking
 * module's own command, which runs the hooks too. Mail goes to a recording
 * port, so a test reads the links that would be emailed.
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
import { FAKE_MINIMUM_AMOUNT } from "@tidegrid/domain-payments";
import type postgres from "postgres";
import { createWaiverHooks } from "./hooks.ts";
import { bookingParticipantDirectory } from "./participants.ts";
import type { WaiverDeps, WaiverMailer, WaiverRequestMessage } from "./ports.ts";
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

export interface WaiverFixture extends CheckoutFixture {
  templateId: string;
}

/** A checkout-ready tenant with an operator template at version 1. */
export async function createWaiverFixture(
  admin: Sql,
  db: Db,
  label: string,
  options: { days?: number } = {},
): Promise<WaiverFixture> {
  const tenant = await createCheckoutFixture(admin, db, label, options);
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
  return { ...tenant, templateId };
}

/** Keeps every message a command queued, including ones whose transaction rolled back. */
export class RecordingMailer implements WaiverMailer {
  readonly sent: WaiverRequestMessage[] = [];

  async enqueue(
    _trx: unknown,
    _ctx: TenantContext,
    message: WaiverRequestMessage,
  ): Promise<{ messageId: string | null }> {
    this.sent.push(message);
    return { messageId: null };
  }

  /** The last message queued for a request. */
  lastFor(requestId: string): WaiverRequestMessage {
    const found = [...this.sent].reverse().find((m) => m.requestId === requestId);
    if (!found) throw new Error(`no message for request ${requestId}`);
    return found;
  }
}

export const FIXTURE_ORIGIN = "https://waivers.book.example.test";

export function fixtureDeps(mailer: RecordingMailer): WaiverDeps {
  return {
    participants: bookingParticipantDirectory,
    mailer,
    guestOrigin: async () => FIXTURE_ORIGIN,
  };
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

/** The waiver hooks with the recording mailer, as the API wires them. */
export function fixtureHooks(mailer: RecordingMailer): BookingHooks {
  return createWaiverHooks(fixtureDeps(mailer));
}

/** The entry token in a link's fragment. */
export function tokenOf(link: string): string {
  const token = new URL(link).hash.match(/^#t=([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new Error(`no token in ${link}`);
  return token;
}
