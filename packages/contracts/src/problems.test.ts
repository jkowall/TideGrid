import { describe, expect, it } from "vitest";
import { CheckoutPaymentResponse } from "./checkout.ts";
import { ErrorResponse } from "./index.ts";
import { ProblemResponse, problemBody } from "./problems.ts";

describe("ProblemResponse (W1-GUEST-API D1)", () => {
  const body = problemBody({
    status: 422,
    code: "unknown_add_on",
    message: "This quote cannot be priced: unknown_add_on (kayak), insufficient_capacity",
    requestId: "req_1",
    problems: [
      { code: "unknown_add_on", subject: "kayak" },
      { code: "insufficient_capacity", subject: null },
    ],
    remaining: 2,
  });

  it("is the shared envelope plus the RFC 9457 members", () => {
    expect(body).toEqual({
      error: {
        code: "unknown_add_on",
        message: "This quote cannot be priced: unknown_add_on (kayak), insufficient_capacity",
        requestId: "req_1",
      },
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "This quote cannot be priced: unknown_add_on (kayak), insufficient_capacity",
      code: "unknown_add_on",
      problems: [
        { code: "unknown_add_on", subject: "kayak" },
        { code: "insufficient_capacity", subject: null },
      ],
      remaining: 2,
    });
    expect(ProblemResponse.safeParse(body).success).toBe(true);
  });

  it("still parses as the old envelope, so existing clients read error.code unchanged", () => {
    const old = ErrorResponse.safeParse(body);
    expect(old.success && old.data.error.code).toBe("unknown_add_on");
  });

  it("names the code alone when no problems are given, and a 409 is a Conflict", () => {
    const conflict = problemBody({
      status: 409,
      code: "trip_not_bookable",
      message: "This trip is not on sale now",
      requestId: "req_2",
    });
    expect(conflict.title).toBe("Conflict");
    expect(conflict.problems).toEqual([{ code: "trip_not_bookable", subject: null }]);
    expect("remaining" in conflict).toBe(false);
  });

  it("refuses a body without problems, a negative or fractional count, or another type", () => {
    expect(ProblemResponse.safeParse({ ...body, problems: [] }).success).toBe(false);
    expect(ProblemResponse.safeParse({ ...body, remaining: -1 }).success).toBe(false);
    expect(ProblemResponse.safeParse({ ...body, remaining: 1.5 }).success).toBe(false);
    expect(ProblemResponse.safeParse({ ...body, type: "https://example.test/x" }).success).toBe(
      false,
    );
    expect(ProblemResponse.safeParse({ error: body.error }).success).toBe(false);
  });
});

describe("CheckoutPaymentResponse (W1-GUEST-API)", () => {
  const session = {
    id: "5d0c4a1e-2b3c-4d5e-8f60-000000000001",
    state: "open",
    quoteId: "0b7f3a52-9c1e-4d2a-8f6b-000000000001",
    tripId: "a99737eb-69c6-4c43-a430-a33aa4740556",
    partySize: 2,
    amount: 9000,
    currency: "USD",
    expiresAt: "2026-11-08T12:15:00.000Z",
    createdAt: "2026-11-08T12:00:00.000Z",
    booking: null,
    refund: null,
  };

  it("carries the payment while open, and null otherwise", () => {
    const payment = { provider: "fake", paymentRef: "fpay_1", clientSecret: "fpay_1_secret_x" };
    expect(CheckoutPaymentResponse.safeParse({ checkoutSession: session, payment }).success).toBe(
      true,
    );
    expect(
      CheckoutPaymentResponse.safeParse({
        checkoutSession: { ...session, state: "expired" },
        payment: null,
      }).success,
    ).toBe(true);
    expect(CheckoutPaymentResponse.safeParse({ checkoutSession: session }).success).toBe(false);
  });
});
