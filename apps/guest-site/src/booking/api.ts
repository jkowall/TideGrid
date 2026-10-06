import {
  type AvailableTrip,
  type CheckoutPayment,
  type CheckoutSession,
  CheckoutSessionCreateResponse,
  CheckoutSessionResponse,
  ErrorResponse,
  FakePaymentControlResponse,
  type Quote,
  type QuoteCreateRequest,
  QuoteResponse,
  TripAvailabilityResponse,
  type TripOffer,
  TripOfferResponse,
} from "@tidegrid/contracts";
import type { z } from "zod";
import { apiBase } from "../bootstrap.ts";

/**
 * The guest checkout's calls to the API. The browser sends the page's Origin
 * and the API answers for the operator published there. Every answer is
 * parsed against the contract before the page uses it.
 *
 * Secrets: the checkout secret and the payment's client secret travel only in
 * an Authorization header, and the booker's name and email only in a POST
 * body. No path or query here ever carries them; tests check every URL.
 */

/** Why a call did not produce what was asked for. */
export type Failure =
  /** No answer: offline, blocked, or no answer in time. A command may or may not have happened. */
  | { kind: "network" }
  /** A success answer that breaks the contract. */
  | { kind: "unreadable" }
  /** The API's own refusal, or a server error, with its code. */
  | { kind: "refused"; status: number; code: string; message: string };

export type Result<T> = { kind: "ok"; value: T; replayed: boolean } | Failure;

export const readTimeoutMs = 10_000;
/** Opening a checkout calls the payment provider after commit, so commands get longer. */
export const commandTimeoutMs = 20_000;

interface RequestOptions<S extends z.ZodType> {
  method?: "GET" | "POST";
  /** Sent as JSON. Personal data goes here, never in the path. */
  body?: unknown;
  /** Idempotency-Key for a command that takes one. */
  key?: string;
  /** A capability secret, sent only as `Authorization: Bearer`. */
  bearer?: string;
  schema: S;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  /** Let the request finish after the page has gone, as a release on leaving does. */
  keepalive?: boolean;
}

/**
 * One call. Uses one AbortController and setTimeout, as the bootstrap does,
 * not AbortSignal.any or AbortSignal.timeout. Never throws.
 */
async function call<S extends z.ZodType>(
  path: string,
  options: RequestOptions<S>,
): Promise<Result<z.infer<S>>> {
  const {
    method = "GET",
    body,
    key,
    bearer,
    schema,
    signal,
    timeoutMs = readTimeoutMs,
    keepalive = false,
  } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopListening = () => {};
  try {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    else if (signal) {
      const forward = () => controller.abort();
      signal.addEventListener("abort", forward, { once: true });
      stopListening = () => signal.removeEventListener("abort", forward);
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers["idempotency-key"] = key;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(`${apiBase}${path}`, {
      method,
      credentials: "omit",
      // Nothing about a checkout belongs in a referrer or a cache.
      cache: "no-store",
      referrerPolicy: "no-referrer",
      ...(keepalive ? { keepalive: true } : {}),
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const error = ErrorResponse.safeParse(json);
      return {
        kind: "refused",
        status: res.status,
        code: error.success ? error.data.error.code : "unknown",
        message: error.success ? error.data.error.message : "",
      };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return { kind: "unreadable" };
    return {
      kind: "ok",
      value: parsed.data,
      replayed: res.headers.get("idempotent-replayed") === "true",
    };
  } catch {
    return { kind: "network" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stopListening();
  }
}

const mapOk = <T, U>(result: Result<T>, map: (value: T) => U): Result<U> =>
  result.kind === "ok" ? { ...result, value: map(result.value) } : result;

/** What the operator sells on one trip: tickets or the charter, add-ons, fees, taxes, the policy. */
export async function getOffer(tripId: string, signal?: AbortSignal): Promise<Result<TripOffer>> {
  const result = await call(`/v1/public/trips/${encodeURIComponent(tripId)}/offer`, {
    schema: TripOfferResponse,
    signal,
  });
  return mapOk(result, (r) => r.offer);
}

/**
 * The trip as the Upcoming trips list shows it: meeting point, duration,
 * seats left, and the booking cutoff. The offer has none of these, so the page
 * asks the availability query for the trip's own date and product. Null when
 * the trip is not listed for the product's smallest party.
 */
export async function getListing(
  offer: TripOffer,
  signal?: AbortSignal,
): Promise<Result<AvailableTrip | null>> {
  const params = new URLSearchParams({
    from: offer.trip.localDate,
    to: offer.trip.localDate,
    party: String(Math.max(1, offer.product.minPartySize)),
    product: offer.product.id,
  });
  const result = await call(`/v1/public/trips?${params}`, {
    schema: TripAvailabilityResponse,
    signal,
  });
  return mapOk(result, (r) => r.trips.find((t) => t.tripId === offer.tripId) ?? null);
}

export type QuoteBody = z.input<typeof QuoteCreateRequest>;

export async function createQuote(
  body: QuoteBody,
  key: string,
  signal?: AbortSignal,
): Promise<Result<Quote>> {
  const result = await call("/v1/public/quotes", {
    method: "POST",
    body,
    key,
    schema: QuoteResponse,
    signal,
    timeoutMs: commandTimeoutMs,
  });
  return mapOk(result, (r) => r.quote);
}

export async function getQuote(quoteId: string, signal?: AbortSignal): Promise<Result<Quote>> {
  const result = await call(`/v1/public/quotes/${encodeURIComponent(quoteId)}`, {
    schema: QuoteResponse,
    signal,
  });
  return mapOk(result, (r) => r.quote);
}

export interface CheckoutBody {
  quoteId: string;
  acceptedPolicyVersion: number;
  booker: { name: string; email: string };
  checkoutSecret: string;
}

export interface OpenedCheckout {
  session: CheckoutSession;
  /** Null when the checkout was no longer open or had passed its expiry. */
  payment: CheckoutPayment | null;
}

export async function openCheckout(
  body: CheckoutBody,
  key: string,
  signal?: AbortSignal,
): Promise<Result<OpenedCheckout>> {
  const result = await call("/v1/public/checkout-sessions", {
    method: "POST",
    body,
    key,
    schema: CheckoutSessionCreateResponse,
    signal,
    timeoutMs: commandTimeoutMs,
  });
  return mapOk(result, (r) => ({ session: r.checkoutSession, payment: r.payment }));
}

export async function readCheckout(
  sessionId: string,
  secret: string,
  signal?: AbortSignal,
): Promise<Result<CheckoutSession>> {
  const result = await call(`/v1/public/checkout-sessions/${encodeURIComponent(sessionId)}`, {
    bearer: secret,
    schema: CheckoutSessionResponse,
    signal,
  });
  return mapOk(result, (r) => r.checkoutSession);
}

/**
 * Abandon an open checkout: the seats are released at once. The API takes no
 * Idempotency-Key here; canceling is idempotent by checkout, so a retry sends
 * the same request again. `keepalive` lets the request outlive the page, for
 * a checkout left behind.
 */
export async function cancelCheckout(
  sessionId: string,
  secret: string,
  options: { signal?: AbortSignal | undefined; keepalive?: boolean } = {},
): Promise<Result<CheckoutSession>> {
  const result = await call(
    `/v1/public/checkout-sessions/${encodeURIComponent(sessionId)}/cancel`,
    {
      method: "POST",
      bearer: secret,
      schema: CheckoutSessionResponse,
      signal: options.signal,
      keepalive: options.keepalive ?? false,
      timeoutMs: commandTimeoutMs,
    },
  );
  return mapOk(result, (r) => r.checkoutSession);
}

export type TestPaymentOutcome = "succeed" | "fail";

/**
 * The demo's fake provider: settle the test payment as paid or declined, as a
 * hosted payment page would. Settling is idempotent by payment (the first
 * outcome stands), so the API takes no Idempotency-Key and a retry sends the
 * same request. The answer says only that the provider sent its event; the
 * page learns what happened from the checkout's own state.
 */
export async function settleTestPayment(
  payment: Pick<CheckoutPayment, "paymentRef" | "clientSecret">,
  outcome: TestPaymentOutcome,
  signal?: AbortSignal,
): Promise<Result<z.infer<typeof FakePaymentControlResponse>>> {
  return call(`/v1/fake-provider/payments/${encodeURIComponent(payment.paymentRef)}/${outcome}`, {
    method: "POST",
    body: {},
    bearer: payment.clientSecret,
    schema: FakePaymentControlResponse,
    signal,
    timeoutMs: commandTimeoutMs,
  });
}

// Secrets and keys ------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The guest's capability for one checkout: 32 random bytes, 43 base64url characters. */
export function newCheckoutSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** A random UUID (version 4), from getRandomValues so it works in any context. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The Idempotency-Key of one command. Sending the same request again, after
 * no answer or an error, reuses the key, so the API applies the command once
 * however often it arrives. A request with another body, or any request after
 * a success, is a new command with a new key: re-quoting the same party after
 * a price expires must not replay the expired quote.
 */
export class CommandKey {
  #pending: { key: string; fingerprint: string } | null = null;

  /** The key for a request; `fingerprint` identifies its body. */
  for(fingerprint: string): string {
    if (this.#pending?.fingerprint !== fingerprint) {
      this.#pending = { key: newIdempotencyKey(), fingerprint };
    }
    return this.#pending.key;
  }

  /** The command took effect: the next request is a new command. */
  done(): void {
    this.#pending = null;
  }
}

/**
 * One attempt to open a checkout: its key and the checkout secret sent with
 * it. Both stay the same while the same quote, policy, and booker are sent
 * again, because a retry must repeat the first request exactly: the API
 * answers a reused key with another body with 422.
 */
export class CheckoutAttempt {
  #pending: { fingerprint: string; key: string; secret: string } | null = null;

  for(fingerprint: string): { key: string; secret: string } {
    if (this.#pending?.fingerprint !== fingerprint) {
      this.#pending = { fingerprint, key: newIdempotencyKey(), secret: newCheckoutSecret() };
    }
    return { key: this.#pending.key, secret: this.#pending.secret };
  }

  /** True while an attempt may exist on the server: its answer never arrived. */
  get pending(): boolean {
    return this.#pending !== null;
  }

  done(): void {
    this.#pending = null;
  }
}

/**
 * Whether a failure leaves the command's outcome unknown, so only the same
 * request may follow. A 503 `payments_unavailable` is definite: the API
 * refuses before writing anything when payments are not configured.
 */
export function outcomeUnknown(failure: Failure): boolean {
  return (
    failure.kind === "network" ||
    failure.kind === "unreadable" ||
    (failure.kind === "refused" && failure.status >= 500 && failure.code !== "payments_unavailable")
  );
}
