import {
  CancelBookingResponse,
  CancellationTermsResponse,
  type ManagedBooking,
  ManagedBookingResponse,
  ManageLinkAccepted,
  ManageSessionEndResponse,
  ManageSessionResponse,
  type Participant,
  type ParticipantInput,
  ParticipantResponse,
} from "@tidegrid/contracts";
import { call, commandTimeoutMs, type Result } from "../booking/api.ts";

/**
 * The management page's calls to the API (lane 1, G2.11c). As in the
 * checkout, the browser sends the page's Origin and every answer is parsed
 * against the contract. The link's token and the session's token travel only
 * in a POST body and an Authorization header: no path or query here ever
 * carries a token or personal data.
 */

export interface OpenedSession {
  token: string;
  expiresAt: string;
  reference: string;
}

const mapOk = <T, U>(result: Result<T>, map: (value: T) => U): Result<U> =>
  result.kind === "ok" ? { ...result, value: map(result.value) } : result;

/** Exchange the link's token for a session. Only an explicit action calls this. */
export async function openWithLink(
  token: string,
  signal?: AbortSignal,
): Promise<Result<OpenedSession>> {
  const result = await call("/v1/public/booking-access", {
    method: "POST",
    body: { token },
    schema: ManageSessionResponse,
    signal,
    timeoutMs: commandTimeoutMs,
  });
  return mapOk(result, (r) => ({ ...r.session, reference: r.booking.reference }));
}

/** Right after paying: the checkout's own secret opens its booking. */
export async function openFromCheckout(
  checkoutSessionId: string,
  checkoutSecret: string,
  signal?: AbortSignal,
): Promise<Result<OpenedSession>> {
  const result = await call(
    `/v1/public/checkout-sessions/${encodeURIComponent(checkoutSessionId)}/manage-session`,
    {
      method: "POST",
      bearer: checkoutSecret,
      schema: ManageSessionResponse,
      signal,
      timeoutMs: commandTimeoutMs,
    },
  );
  return mapOk(result, (r) => ({ ...r.session, reference: r.booking.reference }));
}

/** Ask for a new link from an old one; the answer is the same whatever the token names. */
export async function renewLink(token: string, signal?: AbortSignal): Promise<Result<true>> {
  const result = await call("/v1/public/booking-access/renewals", {
    method: "POST",
    body: { token },
    schema: ManageLinkAccepted,
    signal,
  });
  return mapOk(result, () => true as const);
}

export async function readBooking(
  session: string,
  signal?: AbortSignal,
): Promise<Result<{ booking: ManagedBooking; expiresAt: string }>> {
  const result = await call("/v1/public/manage/booking", {
    bearer: session,
    schema: ManagedBookingResponse,
    signal,
  });
  return mapOk(result, (r) => ({ booking: r.booking, expiresAt: r.session.expiresAt }));
}

export async function saveParticipant(
  session: string,
  position: number,
  input: ParticipantInput,
  key: string,
  signal?: AbortSignal,
): Promise<Result<{ participant: Participant; created: boolean }>> {
  return call(`/v1/public/manage/participants/${position}`, {
    method: "PUT",
    bearer: session,
    body: input,
    key,
    schema: ParticipantResponse,
    signal,
    timeoutMs: commandTimeoutMs,
  });
}

export async function readTerms(session: string, signal?: AbortSignal) {
  const result = await call("/v1/public/manage/cancellation", {
    bearer: session,
    schema: CancellationTermsResponse,
    signal,
  });
  return mapOk(result, (r) => r.terms);
}

export async function cancel(
  session: string,
  expectedRefundAmount: number,
  key: string,
  signal?: AbortSignal,
): Promise<Result<ManagedBooking>> {
  const result = await call("/v1/public/manage/cancellation", {
    method: "POST",
    bearer: session,
    body: { expectedRefundAmount },
    key,
    schema: CancelBookingResponse,
    signal,
    timeoutMs: commandTimeoutMs,
  });
  return mapOk(result, (r) => r.booking);
}

export async function emailNewLink(session: string, signal?: AbortSignal): Promise<Result<true>> {
  const result = await call("/v1/public/manage/link-email", {
    method: "POST",
    bearer: session,
    schema: ManageLinkAccepted,
    signal,
  });
  return mapOk(result, () => true as const);
}

export async function endSession(session: string, signal?: AbortSignal): Promise<Result<true>> {
  const result = await call("/v1/public/manage/session/end", {
    method: "POST",
    bearer: session,
    schema: ManageSessionEndResponse,
    signal,
  });
  return mapOk(result, () => true as const);
}
