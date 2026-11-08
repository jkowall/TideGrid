import {
  type CheckoutPayment,
  type CheckoutSession,
  CheckoutSessionCreateResponse,
  CheckoutSessionResponse,
  FakePaymentControlResponse,
  type GuestParticipantWaiver,
  type ManagedBooking,
  ManagedBookingResponse,
  ManageSessionEndResponse,
  ManageSessionResponse,
  ManageWaiversResponse,
  type Quote,
  type QuoteCreateRequest,
  QuoteResponse,
  type TripOffer,
  TripOfferResponse,
} from "@tidegrid/contracts";
import type { z } from "zod";
import { call, commandTimeoutMs, mapOk, type Result } from "./http.ts";
import type { Endpoint } from "./variant.ts";

/**
 * The booking journey's calls: the same guest API routes, bodies, and headers
 * the guest web app uses (src/booking/api.ts, src/manage/api.ts, and
 * src/waiver/api.ts in apps/guest-site). No API change.
 */

type Fetch = typeof fetch | undefined;
const f = (fetchImpl: Fetch) => (fetchImpl ? { fetchImpl } : {});
const seg = encodeURIComponent;

export async function getOffer(e: Endpoint, tripId: string, fetchImpl?: Fetch) {
  const r = await call(e, `/v1/public/trips/${seg(tripId)}/offer`, {
    schema: TripOfferResponse,
    ...f(fetchImpl),
  });
  return mapOk(r, (v): TripOffer => v.offer);
}

export type QuoteBody = z.input<typeof QuoteCreateRequest>;

export async function createQuote(e: Endpoint, body: QuoteBody, key: string, fetchImpl?: Fetch) {
  const r = await call(e, "/v1/public/quotes", {
    method: "POST",
    body,
    key,
    schema: QuoteResponse,
    timeoutMs: commandTimeoutMs,
    ...f(fetchImpl),
  });
  return mapOk(r, (v): Quote => v.quote);
}

export interface CheckoutBody {
  quoteId: string;
  acceptedPolicyVersion: number;
  booker: { name: string; email: string };
  checkoutSecret: string;
}

export async function openCheckout(
  e: Endpoint,
  body: CheckoutBody,
  key: string,
  fetchImpl?: Fetch,
): Promise<Result<{ session: CheckoutSession; payment: CheckoutPayment | null }>> {
  const r = await call(e, "/v1/public/checkout-sessions", {
    method: "POST",
    body,
    key,
    schema: CheckoutSessionCreateResponse,
    timeoutMs: commandTimeoutMs,
    ...f(fetchImpl),
  });
  return mapOk(r, (v) => ({ session: v.checkoutSession, payment: v.payment }));
}

export async function readCheckout(e: Endpoint, id: string, secret: string, fetchImpl?: Fetch) {
  const r = await call(e, `/v1/public/checkout-sessions/${seg(id)}`, {
    bearer: secret,
    schema: CheckoutSessionResponse,
    ...f(fetchImpl),
  });
  return mapOk(r, (v): CheckoutSession => v.checkoutSession);
}

/** Give the seats back. Idempotent by checkout, so the API takes no key. */
export async function cancelCheckout(e: Endpoint, id: string, secret: string, fetchImpl?: Fetch) {
  const r = await call(e, `/v1/public/checkout-sessions/${seg(id)}/cancel`, {
    method: "POST",
    bearer: secret,
    schema: CheckoutSessionResponse,
    timeoutMs: commandTimeoutMs,
    ...f(fetchImpl),
  });
  return mapOk(r, (v): CheckoutSession => v.checkoutSession);
}

export type TestPaymentOutcome = "succeed" | "fail";

/**
 * The demo's fake provider: settle the test payment as paid or declined. The
 * app then learns what happened from the checkout's own state, which only the
 * provider's verified event changes.
 */
export async function settleTestPayment(
  e: Endpoint,
  payment: Pick<CheckoutPayment, "paymentRef" | "clientSecret">,
  outcome: TestPaymentOutcome,
  fetchImpl?: Fetch,
) {
  return call(e, `/v1/fake-provider/payments/${seg(payment.paymentRef)}/${outcome}`, {
    method: "POST",
    body: {},
    bearer: payment.clientSecret,
    schema: FakePaymentControlResponse,
    timeoutMs: commandTimeoutMs,
    ...f(fetchImpl),
  });
}

export interface OpenedSession {
  token: string;
  expiresAt: string;
  reference: string;
}

/** Right after paying: the checkout's own secret opens its booking. */
export async function openFromCheckout(e: Endpoint, id: string, secret: string, fetchImpl?: Fetch) {
  const r = await call(e, `/v1/public/checkout-sessions/${seg(id)}/manage-session`, {
    method: "POST",
    bearer: secret,
    schema: ManageSessionResponse,
    timeoutMs: commandTimeoutMs,
    ...f(fetchImpl),
  });
  return mapOk(r, (v): OpenedSession => ({ ...v.session, reference: v.booking.reference }));
}

/** Exchange the email link's token for a booking session. The link works once. */
export async function openWithLink(e: Endpoint, token: string, fetchImpl?: Fetch) {
  const r = await call(e, "/v1/public/booking-access", {
    method: "POST",
    body: { token },
    schema: ManageSessionResponse,
    timeoutMs: commandTimeoutMs,
    ...f(fetchImpl),
  });
  return mapOk(r, (v): OpenedSession => ({ ...v.session, reference: v.booking.reference }));
}

export async function readBooking(e: Endpoint, session: string, fetchImpl?: Fetch) {
  const r = await call(e, "/v1/public/manage/booking", {
    bearer: session,
    schema: ManagedBookingResponse,
    ...f(fetchImpl),
  });
  return mapOk(r, (v): { booking: ManagedBooking; expiresAt: string } => ({
    booking: v.booking,
    expiresAt: v.session.expiresAt,
  }));
}

export interface PartyWaivers {
  applies: boolean;
  unnamedPlaces: number;
  participants: GuestParticipantWaiver[];
}

export async function readPartyWaivers(e: Endpoint, session: string, fetchImpl?: Fetch) {
  const r = await call(e, "/v1/public/manage/waivers", {
    bearer: session,
    schema: ManageWaiversResponse,
    ...f(fetchImpl),
  });
  return mapOk(r, (v): PartyWaivers => v.waivers);
}

export async function endSession(e: Endpoint, session: string, fetchImpl?: Fetch) {
  const r = await call(e, "/v1/public/manage/session/end", {
    method: "POST",
    bearer: session,
    schema: ManageSessionEndResponse,
    ...f(fetchImpl),
  });
  return mapOk(r, () => true as const);
}
