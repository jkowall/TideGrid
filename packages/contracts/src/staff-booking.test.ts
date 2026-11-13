import { describe, expect, it } from "vitest";
import { BookingDetail, RosterBooking } from "./bookings.ts";
import { BookingChannel, BookingSource, StaffBooking } from "./checkout.ts";
import {
  StaffCheckoutCreateRequest,
  StaffComplimentaryBookingRequest,
  StaffTestPaymentRequest,
} from "./staff-booking.ts";

const open = {
  quoteId: "6a1c3e50-7b2d-4f8e-9a6b-1c2d3e4f5a61",
  acceptedPolicyVersion: 3,
  booker: { name: "Rosa Telefono", email: "rosa@guest.example" },
  channel: "phone",
  attestations: { policyToldToGuest: true, emailReadBack: true },
};

describe("staff-assisted booking contracts (G2.12d)", () => {
  it("takes a checkout with both attestations, a channel, and the booker", () => {
    expect(StaffCheckoutCreateRequest.safeParse(open).success).toBe(true);
  });

  it.each([
    [
      "an unchecked attestation",
      { attestations: { policyToldToGuest: false, emailReadBack: true } },
    ],
    ["no attestations", { attestations: undefined }],
    ["an unknown channel", { channel: "fax" }],
    ["a control character in the name", { booker: { name: "Rosa\u0007", email: "r@g.example" } }],
    ["a C1 control in the name", { booker: { name: "Rosa\u0085", email: "r@g.example" } }],
    ["a non-ASCII address", { booker: { name: "Rosa", email: "rosa@münchen.example" } }],
    ["a malformed quote id", { quoteId: "nope" }],
    ["policy version 0", { acceptedPolicyVersion: 0 }],
  ])("refuses %s", (_label, change) => {
    expect(StaffCheckoutCreateRequest.safeParse({ ...open, ...change }).success).toBe(false);
  });

  it("never lets a client name the source or the opener", () => {
    const parsed = StaffCheckoutCreateRequest.parse({
      ...open,
      source: "direct",
      openedBy: "someone",
    });
    expect(Object.keys(parsed).sort()).toEqual(
      ["acceptedPolicyVersion", "attestations", "booker", "channel", "quoteId"].sort(),
    );
  });

  it("takes succeed or fail only, for a test payment", () => {
    expect(StaffTestPaymentRequest.safeParse({ outcome: "succeed" }).success).toBe(true);
    expect(StaffTestPaymentRequest.safeParse({ outcome: "fail" }).success).toBe(true);
    expect(StaffTestPaymentRequest.safeParse({ outcome: "refund" }).success).toBe(false);
  });

  it("widens the source and names the channels", () => {
    expect(BookingSource.options).toEqual([
      "direct",
      "staff_assisted",
      "complimentary",
      "imported",
    ]);
    expect(BookingChannel.options).toEqual(["phone", "email", "walk_up"]);
    expect(StaffBooking.shape.source.safeParse("staff_assisted").success).toBe(true);
    expect(StaffBooking.shape.source.safeParse("imported").success).toBe(true);
    expect(StaffBooking.shape.source.safeParse("ota").success).toBe(false);
  });

  it("takes an owner's complimentary grant with a reason, and a note for other", () => {
    const base = {
      quoteId: "00000000-0000-4000-8000-000000000001",
      acceptedPolicyVersion: 1,
      booker: { name: "Maya Lopez", email: "maya@example.com" },
      channel: "phone",
      attestations: { policyToldToGuest: true, emailReadBack: true },
    };
    const ok = (complimentary: unknown) =>
      StaffComplimentaryBookingRequest.safeParse({ ...base, complimentary }).success;
    expect(ok({ reasonCode: "service_recovery" })).toBe(true);
    expect(ok({ reasonCode: "other", note: "Skipper's family" })).toBe(true);
    expect(ok({ reasonCode: "other" })).toBe(false);
    expect(ok({ reasonCode: "other", note: "line\nbreak" })).toBe(false);
    expect(ok({ reasonCode: "free" })).toBe(false);
    expect(StaffComplimentaryBookingRequest.safeParse(base).success).toBe(false);
  });

  it("keeps channel and openedBy optional on reads, so older clients' data still parses", () => {
    expect(BookingDetail.shape.channel.safeParse(undefined).success).toBe(true);
    expect(BookingDetail.shape.channel.safeParse(null).success).toBe(true);
    expect(BookingDetail.shape.openedBy.safeParse(undefined).success).toBe(true);
    expect(
      BookingDetail.shape.openedBy.safeParse({
        userId: "5f0c3a52-2a55-4f8a-9d7e-5d6f0f1b2a02",
        displayName: "Ben Desk",
      }).success,
    ).toBe(true);
    expect(RosterBooking.shape.source.safeParse(undefined).success).toBe(true);
    expect(RosterBooking.shape.channel.safeParse("walk_up").success).toBe(true);
  });
});
