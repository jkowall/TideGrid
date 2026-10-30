import {
  BookingEmailResendBlock,
  MESSAGE_FAILURE_CODES,
  MessageDeliveryState,
} from "@tidegrid/contracts";
import { iconNames } from "@tidegrid/design-system/components";
import { describe, expect, it } from "vitest";
import { canResendEmail } from "../roles.ts";
import { availability, message } from "./fixtures.ts";
import {
  blockedText,
  failureCopy,
  failureText,
  isBookingEmail,
  reasonOptions,
  resendFailureText,
  stateView,
  templateName,
  whenText,
} from "./model.ts";

const when = (iso: string) => `[${iso}]`;

describe("a booking's email in words (G2.16b)", () => {
  it("has copy for every failure code the contract lists, in sentences with no codes", () => {
    expect(Object.keys(failureCopy).sort()).toEqual([...MESSAGE_FAILURE_CODES].sort());
    for (const code of MESSAGE_FAILURE_CODES) {
      const copy = failureText(code);
      expect(copy, code).toMatch(/^[A-Z].*\.$/);
      expect(copy, code).not.toMatch(/_/);
    }
  });

  it("says what the three codes staff act on mean", () => {
    expect(failureText("outcome_unknown")).toBe(
      "The email service did not answer, so TideGrid did not try again, to avoid a second working link. Send it again if the guest did not get it.",
    );
    expect(failureText("resent")).toBe("Replaced by a newer email before it went out.");
    expect(failureText("bounced")).toContain("refused it");
  });

  it("gives a code it does not know generic words, never the code", () => {
    expect(failureText("carrier_pigeon_lost")).toBe(
      "The email service reported a problem TideGrid doesn't describe yet.",
    );
    expect(failureText(null)).toBeNull();
  });

  it("shows every state as an icon and a label, an unknown outcome apart from a failure", () => {
    for (const state of MessageDeliveryState.options) {
      const view = stateView(message({ state, attempts: 1 }));
      expect(iconNames, state).toContain(view.icon);
      expect(view.label.length, state).toBeGreaterThan(0);
    }
    expect(stateView(message({ state: "failed", failureCode: "outcome_unknown" }))).toEqual({
      tone: "warning",
      icon: "alert-triangle",
      label: "Outcome unknown",
    });
    expect(stateView(message({ state: "failed", failureCode: "bounced" })).label).toBe("Failed");
    expect(stateView(message({ state: "queued", attempts: 0 })).label).toBe("Waiting to send");
    expect(stateView(message({ state: "queued", attempts: 2 })).label).toBe("Trying again");
  });

  it("says sent means accepted by the email service, not read", () => {
    expect(whenText(message({ sentAt: "2026-11-04T14:00:02.000Z" }), when, false)).toBe(
      "Accepted by the email service [2026-11-04T14:00:02.000Z]. That doesn't mean the guest read it.",
    );
  });

  it("says when, and how many attempts, for every state", () => {
    expect(whenText(message({ state: "queued", attempts: 0, sentAt: null }), when, false)).toBe(
      "Queued [2026-11-04T14:00:00.000Z].",
    );
    expect(whenText(message({ state: "queued", attempts: 0, sentAt: null }), when, true)).toBe(
      "Queued [2026-11-04T14:00:00.000Z]. Email is off here, so it waits.",
    );
    expect(
      whenText(
        message({
          state: "queued",
          attempts: 2,
          sentAt: null,
          nextAttemptAt: "2026-11-04T15:00:00.000Z",
        }),
        when,
        false,
      ),
    ).toBe("Next try [2026-11-04T15:00:00.000Z], after 2 attempts.");
    expect(whenText(message({ state: "sending", sentAt: null }), when, false)).toBe(
      "Being sent now (1 attempt).",
    );
    expect(
      whenText(
        message({ state: "failed", sentAt: null, failedAt: "2026-11-04T14:01:00.000Z" }),
        when,
        false,
      ),
    ).toBe("Stopped [2026-11-04T14:01:00.000Z], after 1 attempt.");
    expect(
      whenText(
        message({
          state: "canceled",
          attempts: 0,
          sentAt: null,
          canceledAt: "2026-11-04T14:02:00.000Z",
        }),
        when,
        false,
      ),
    ).toBe("Canceled [2026-11-04T14:02:00.000Z].");
  });

  it("names the booking's emails and leaves waiver requests to the Waivers card", () => {
    expect(templateName("booking_confirmation")).toBe("Confirmation");
    expect(templateName("booking_canceled")).toBe("Cancellation notice");
    expect(templateName("booking_manage_link")).toBe("Booking link");
    expect(templateName("booking_refund_failed")).toBe("Refund problem notice");
    expect(templateName("booking_receipt_v9")).toBe("Booking email");
    expect(isBookingEmail({ template: "waiver_request" })).toBe(false);
    expect(isBookingEmail({ template: "booking_confirmation" })).toBe(true);
  });

  it("explains every reason Send again is not offered, with the time when there is one", () => {
    for (const blockedBy of BookingEmailResendBlock.options) {
      const copy = blockedText(
        availability({ allowed: false, blockedBy, availableAt: "2026-11-04T15:10:00.000Z" }),
        when,
      );
      expect(copy, blockedBy).toMatch(/^[A-Z].*\.$/);
      expect(copy, blockedBy).not.toMatch(/_/);
    }
    expect(
      blockedText(
        availability({
          allowed: false,
          blockedBy: "too_soon",
          availableAt: "2026-11-04T15:10:00.000Z",
        }),
        when,
      ),
    ).toContain("from [2026-11-04T15:10:00.000Z]");
    expect(
      blockedText(
        availability({
          allowed: false,
          blockedBy: "rate_limited",
          availableAt: "2026-11-04T15:40:00.000Z",
        }),
        when,
      ),
    ).toContain("from [2026-11-04T15:40:00.000Z]");
    expect(blockedText(availability(), when)).toBeNull();
  });

  it("explains every refusal of a send in its own words", () => {
    const generic = resendFailureText("something_else");
    for (const reason of [
      "email_off",
      "kind_mismatch",
      "trip_over",
      "refund_failed",
      "limit",
      "too_soon",
      "rate_limited",
      "in_progress",
      "email_invalid",
      "forbidden",
      "signed_out",
      "not_found",
      "unreachable",
    ]) {
      expect(resendFailureText(reason), reason).not.toBe(generic);
    }
  });

  it("offers each reason code once, in words", () => {
    expect(reasonOptions.map((o) => o.value)).toEqual([
      "guest_did_not_receive",
      "delivery_failed",
      "delivery_unknown",
      "guest_asked_again",
      "other",
    ]);
  });

  it("lets owners and booking staff send again, never finance", () => {
    expect(canResendEmail("owner")).toBe(true);
    expect(canResendEmail("booking_staff")).toBe(true);
    expect(canResendEmail("finance")).toBe(false);
  });
});
