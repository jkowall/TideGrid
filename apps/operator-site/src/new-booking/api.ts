import type {
  Quote,
  StaffCheckout,
  StaffCheckoutCreateRequest,
  StaffTestPaymentOutcome,
  StaffTestPaymentResponse,
  TripOffer,
} from "@tidegrid/contracts";
import { isInstant, isInt, isString, type Read } from "../bookings/api.ts";
import { call, errorCode, failureOf, type ReadFailure, tenantPath } from "../http.ts";

/**
 * Staff-assisted booking calls (G2.12d). None throws. Reads answer as the
 * booking views' reads do; commands also say which refusal the API gave, so
 * the page can explain it. Every command carries an Idempotency-Key the page
 * keeps for the same body, so a retry is the same request.
 */

/** Why a command did not go through: a read failure, a refusal with its code, or a reused key. */
export type CommandFailure =
  | { reason: ReadFailure; code?: undefined }
  | { reason: "refused"; code: string | undefined }
  | { reason: "key_reused"; code: "idempotency_key_reused" };

export type Command<T> = { kind: "ok"; value: T } | ({ kind: "failed" } & CommandFailure);

const accept = { accept: "application/json" };

const isMoney = isInt;
const checkoutStates = new Set([
  "open",
  "confirmed",
  "unfulfilled",
  "failed",
  "expired",
  "canceled",
]);
const channels = new Set(["phone", "email", "walk_up"]);

/** The parts of an offer the page uses. */
export function isOffer(o: Partial<TripOffer> | null | undefined): o is TripOffer {
  return (
    isString(o?.tripId) &&
    isString(o.product?.name) &&
    (o.product.kind === "shared_seat" || o.product.kind === "private_charter") &&
    isInt(o.product.minPartySize) &&
    isInt(o.product.maxPartySize) &&
    isString(o.trip?.timeZone) &&
    isString(o.trip.localDate) &&
    isString(o.trip.localStartTime) &&
    isInstant(o.trip.startsAt) &&
    Array.isArray(o.tickets) &&
    o.tickets.every((t) => isString(t?.code) && isString(t.name) && isMoney(t.unitAmount)) &&
    (o.charter === null || (isString(o.charter?.name) && isMoney(o.charter.amount))) &&
    Array.isArray(o.addOns) &&
    o.addOns.every(
      (a) =>
        isString(a?.code) &&
        isString(a.name) &&
        isMoney(a.unitAmount) &&
        isInt(a.maxQuantity) &&
        (a.quantityRule === "per_booking" || a.quantityRule === "per_participant"),
    ) &&
    isInt(o.policy?.version) &&
    isString(o.policy.text?.cancellation)
  );
}

export function isQuote(q: Partial<Quote> | null | undefined): q is Quote {
  return (
    isString(q?.quoteId) &&
    isString(q.tripId) &&
    isInt(q.partySize) &&
    Array.isArray(q.lines) &&
    q.lines.every(
      (l) => isInt(l?.lineNo) && isString(l.name) && isInt(l.quantity) && isMoney(l.amount),
    ) &&
    Array.isArray(q.taxes) &&
    q.taxes.every((t) => isString(t?.taxRateId) && isString(t.name) && isMoney(t.amount)) &&
    isMoney(q.totals?.total) &&
    isInt(q.policy?.version) &&
    isString(q.policy.text?.cancellation) &&
    isInstant(q.expiresAt)
  );
}

export function isStaffCheckout(c: Partial<StaffCheckout> | null | undefined): c is StaffCheckout {
  return (
    isString(c?.id) &&
    isString(c.state) &&
    checkoutStates.has(c.state) &&
    isString(c.tripId) &&
    isInt(c.partySize) &&
    isMoney(c.amount) &&
    isInstant(c.expiresAt) &&
    isString(c.channel) &&
    channels.has(c.channel) &&
    isString(c.paymentState) &&
    (c.booking === null || (isString(c.booking?.id) && isString(c.booking.reference))) &&
    (c.refund === null || (isString(c.refund?.state) && isMoney(c.refund.amount)))
  );
}

async function command<T>(
  path: string,
  body: unknown,
  key: string,
  pick: (data: unknown) => T | null,
): Promise<Command<T>> {
  try {
    const res = await call(path, {
      method: "POST",
      headers: { ...accept, "content-type": "application/json", "Idempotency-Key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok) {
      const value = pick(await res.json().catch(() => null));
      return value === null ? { kind: "failed", reason: "unreadable" } : { kind: "ok", value };
    }
    if (res.status === 409 || res.status === 422 || res.status === 429 || res.status === 503) {
      const code = await errorCode(res.clone());
      if (code === "idempotency_key_reused") {
        return { kind: "failed", reason: "key_reused", code };
      }
      return { kind: "failed", reason: "refused", code };
    }
    if (res.status === 404) {
      const code = await errorCode(res.clone());
      if (code !== "tenant_not_found") return { kind: "failed", reason: "refused", code };
    }
    return { kind: "failed", reason: await failureOf(res) };
  } catch {
    return { kind: "failed", reason: "unreachable" };
  }
}

const offerPath = (tenantId: string, tripId: string) =>
  `${tenantPath(tenantId)}/trips/${encodeURIComponent(tripId)}/offer`;
const checkoutPath = (tenantId: string, id: string) =>
  `${tenantPath(tenantId)}/checkouts/${encodeURIComponent(id)}`;

/** A trip's offer; a trip off sale reads as `refused` with its code. */
export async function loadOffer(
  tenantId: string,
  tripId: string,
  signal?: AbortSignal,
): Promise<Command<TripOffer>> {
  try {
    const res = await call(offerPath(tenantId, tripId), { headers: accept }, signal);
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { offer?: Partial<TripOffer> } | null;
      return isOffer(body?.offer)
        ? { kind: "ok", value: body.offer }
        : { kind: "failed", reason: "unreadable" };
    }
    if (res.status === 409) {
      return { kind: "failed", reason: "refused", code: await errorCode(res) };
    }
    return { kind: "failed", reason: await failureOf(res) };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

export function createQuote(tenantId: string, body: unknown, key: string): Promise<Command<Quote>> {
  return command(`${tenantPath(tenantId)}/quotes`, body, key, (data) => {
    const quote = (data as { quote?: Partial<Quote> } | null)?.quote;
    return isQuote(quote) ? quote : null;
  });
}

export function openCheckout(
  tenantId: string,
  body: StaffCheckoutCreateRequest,
  key: string,
): Promise<Command<{ checkout: StaffCheckout; paymentReady: boolean }>> {
  return command(`${tenantPath(tenantId)}/checkouts`, body, key, (data) => {
    const d = data as { checkout?: Partial<StaffCheckout>; paymentReady?: unknown } | null;
    return isStaffCheckout(d?.checkout) && typeof d.paymentReady === "boolean"
      ? { checkout: d.checkout, paymentReady: d.paymentReady }
      : null;
  });
}

export async function readCheckout(
  tenantId: string,
  checkoutId: string,
  signal?: AbortSignal,
): Promise<Read<StaffCheckout>> {
  try {
    const res = await call(checkoutPath(tenantId, checkoutId), { headers: accept }, signal);
    if (!res.ok) return { kind: "failed", reason: await failureOf(res) };
    const body = (await res.json().catch(() => null)) as {
      checkout?: Partial<StaffCheckout>;
    } | null;
    return isStaffCheckout(body?.checkout)
      ? { kind: "ok", value: body.checkout }
      : { kind: "failed", reason: "unreadable" };
  } catch {
    return { kind: "failed", reason: signal?.aborted ? "unavailable" : "unreachable" };
  }
}

export function cancelCheckout(
  tenantId: string,
  checkoutId: string,
  key: string,
): Promise<Command<StaffCheckout>> {
  return command(`${checkoutPath(tenantId, checkoutId)}/cancel`, undefined, key, (data) => {
    const checkout = (data as { checkout?: Partial<StaffCheckout> } | null)?.checkout;
    return isStaffCheckout(checkout) ? checkout : null;
  });
}

export function takeTestPayment(
  tenantId: string,
  checkoutId: string,
  outcome: StaffTestPaymentOutcome,
  key: string,
): Promise<Command<StaffTestPaymentResponse>> {
  return command(`${checkoutPath(tenantId, checkoutId)}/test-payment`, { outcome }, key, (data) => {
    const d = data as Partial<StaffTestPaymentResponse> | null;
    return isString(d?.checkoutId) &&
      typeof d.alreadySettled === "boolean" &&
      isInt(d.delivery?.status)
      ? (d as StaffTestPaymentResponse)
      : null;
  });
}
