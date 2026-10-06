import { describe, expect, it } from "vitest";
import { CheckoutSessionCreateRequest, CheckoutSessionState } from "./checkout.ts";

const valid = {
  quoteId: "0b7f3a52-9c1e-4d2a-8f6b-1e2d3c4b5a69",
  acceptedPolicyVersion: 1,
  booker: { name: "Ava Guest", email: "ava@example.test" },
  checkoutSecret: "A".repeat(43),
};

describe("checkout contract", () => {
  it("accepts a well-formed request and trims the booker's name", () => {
    const parsed = CheckoutSessionCreateRequest.parse({
      ...valid,
      booker: { name: "  Ava Guest  ", email: "ava@example.test" },
    });
    expect(parsed.booker.name).toBe("Ava Guest");
  });

  it("refuses control characters the database would refuse, before they reach it", () => {
    for (const name of ["Ava\u0000", "Ava\nGuest", "Ava\u007f", "Ava\u0085Guest", "Ava\u009f"]) {
      expect(
        CheckoutSessionCreateRequest.safeParse({ ...valid, booker: { ...valid.booker, name } })
          .success,
      ).toBe(false);
    }
    expect(
      CheckoutSessionCreateRequest.safeParse({
        ...valid,
        booker: { ...valid.booker, name: "Zoë Ångström" },
      }).success,
    ).toBe(true);
  });

  it("refuses a non-ASCII or malformed email, a malformed secret, and no policy", () => {
    const bad = [
      { ...valid, booker: { ...valid.booker, email: "zoë@example.test" } },
      { ...valid, booker: { ...valid.booker, email: "not-an-address" } },
      { ...valid, checkoutSecret: "A".repeat(42) },
      { ...valid, checkoutSecret: `${"A".repeat(42)}=` },
      { ...valid, acceptedPolicyVersion: 0 },
      { ...valid, quoteId: "not-a-uuid" },
    ];
    for (const body of bad) {
      expect(CheckoutSessionCreateRequest.safeParse(body).success).toBe(false);
    }
  });

  it("names the refunded state unfulfilled, never paid", () => {
    expect(CheckoutSessionState.options).toEqual([
      "open",
      "confirmed",
      "unfulfilled",
      "failed",
      "expired",
      "canceled",
    ]);
  });
});
