import type {
  BookingEmailResendAvailability,
  BookingMessagesResponse,
  MessageStatus,
} from "@tidegrid/contracts";
import { vi } from "vitest";

/** Synthetic ids and answers for the booking email card's tests (G2.16b). */

export const tenantId = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01";
export const bookingId = "11111111-2222-4333-8444-555555555555";
export const bookerEmail = "maya.synthetic@example.test";
export const messagesPath = `/api/v1/staff/tenants/${tenantId}/bookings/${bookingId}/messages`;
export const resendPath = `/api/v1/staff/tenants/${tenantId}/bookings/${bookingId}/emails/resend`;

let next = 0;

/** A message as the API sends it: a sent confirmation unless told otherwise. */
export function message(over: Partial<MessageStatus> = {}): MessageStatus {
  next += 1;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    template: "booking_confirmation",
    templateVersion: 1,
    state: "sent",
    attempts: 1,
    lastAttemptAt: "2026-11-04T14:00:01.000Z",
    nextAttemptAt: null,
    sentAt: "2026-11-04T14:00:02.000Z",
    failedAt: null,
    canceledAt: null,
    failureCode: null,
    provider: "fake",
    staffResend: false,
    createdAt: "2026-11-04T14:00:00.000Z",
    ...over,
  };
}

export function availability(
  over: Partial<BookingEmailResendAvailability> = {},
): BookingEmailResendAvailability {
  return {
    kind: "confirmation",
    allowed: true,
    availableAt: null,
    remaining: 5,
    blockedBy: null,
    ...over,
  };
}

export function messagesBody(over: Partial<BookingMessagesResponse> = {}): BookingMessagesResponse {
  return {
    messages: [message()],
    emailDelivery: "on",
    resend: availability(),
    ...over,
  };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const apiError = (status: number, code: string) =>
  json(status, { error: { code, message: code, requestId: "req-test" } });

export interface Sent {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

/**
 * A fetch that answers from `answer` and records every call with its method,
 * path, headers, and parsed body. A thrown answer is a dropped connection.
 */
export function stubApi(answer: (call: Sent) => Response | Promise<Response>): Sent[] {
  const calls: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:5184");
      const call: Sent = {
        method: init?.method ?? "GET",
        path: url.pathname,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

/** An element's text with every run of white space as one space. */
export const text = (element: Element | null | undefined) =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();
