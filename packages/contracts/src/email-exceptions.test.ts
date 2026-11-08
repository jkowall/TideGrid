import { describe, expect, it } from "vitest";
import {
  EmailException,
  EmailExceptionQuery,
  EmailExceptionsResponse,
} from "./email-exceptions.ts";

const row = {
  id: "00000000-0000-4000-8000-000000000001",
  template: "booking_confirmation",
  kind: "booking",
  state: "outcome_unknown",
  attempts: 1,
  failureCode: "outcome_unknown",
  failedAt: "2026-11-04T14:00:03.000Z",
  staffResend: false,
  laterSent: false,
  booking: {
    id: "11111111-2222-4333-8444-555555555555",
    reference: "QKG6ERBF",
    timeZone: "America/New_York",
  },
};

describe("the email exceptions contract (W1-EMAIL-EXC)", () => {
  it("carries no recipient, subject, body, or name", () => {
    expect(Object.keys(EmailException.shape).sort()).toEqual(
      [
        "attempts",
        "booking",
        "failedAt",
        "failureCode",
        "id",
        "kind",
        "laterSent",
        "staffResend",
        "state",
        "template",
      ].sort(),
    );
    const booking = EmailException.shape.booking.unwrap();
    expect(Object.keys(booking.shape).sort()).toEqual(["id", "reference", "timeZone"]);
  });

  it("accepts a page, and a message about no booking", () => {
    expect(
      EmailExceptionsResponse.safeParse({
        exceptions: [row, { ...row, booking: null, kind: "waiver" }],
        nextBefore: null,
      }).success,
    ).toBe(true);
  });

  it("lists only the three exception states", () => {
    for (const state of ["failed", "outcome_unknown", "delivery_failed"]) {
      expect(EmailException.safeParse({ ...row, state }).success, state).toBe(true);
    }
    for (const state of ["queued", "sending", "sent", "canceled", "bounced"]) {
      expect(EmailException.safeParse({ ...row, state }).success, state).toBe(false);
    }
  });

  it("pages 1 to 100 at a time, 50 by default, with a UUID cursor", () => {
    expect(EmailExceptionQuery.parse({})).toEqual({ limit: 50 });
    expect(EmailExceptionQuery.parse({ limit: "100" }).limit).toBe(100);
    for (const limit of ["0", "101", "1.5", "x"]) {
      expect(EmailExceptionQuery.safeParse({ limit }).success, limit).toBe(false);
    }
    expect(EmailExceptionQuery.safeParse({ before: "not-a-uuid" }).success).toBe(false);
    expect(EmailExceptionQuery.safeParse({ before: row.id }).success).toBe(true);
  });
});
