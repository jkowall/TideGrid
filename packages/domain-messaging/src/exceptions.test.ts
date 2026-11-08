import type { TenantTransaction } from "@tidegrid/database";
import { describe, expect, it } from "vitest";
import {
  exceptionKind,
  exceptionState,
  listEmailExceptions,
  MAX_EMAIL_EXCEPTIONS_PAGE,
} from "./exceptions.ts";

/** A transaction the guards must never reach. */
const untouched = new Proxy({} as TenantTransaction, {
  get() {
    throw new Error("the guard should refuse before any query");
  },
});
const tenantId = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01";

describe("the email exceptions read's rules (W1-EMAIL-EXC)", () => {
  it("splits a failed message by its last error into failed, outcome_unknown, and delivery_failed", () => {
    expect(exceptionState("outcome_unknown")).toBe("outcome_unknown");
    expect(exceptionState("delivery_failed")).toBe("delivery_failed");
    for (const code of ["bounced", "retries_exhausted", "invalid_message", "carrier_pigeon_lost"]) {
      expect(exceptionState(code), code).toBe("failed");
    }
  });

  it("labels waiver email as waiver and every other template as the booking's own", () => {
    expect(exceptionKind("waiver_request")).toBe("waiver");
    expect(exceptionKind("waiver_reminder")).toBe("waiver");
    for (const template of [
      "booking_confirmation",
      "booking_manage_link",
      "booking_canceled",
      "booking_refund_failed",
      "test_message",
    ]) {
      expect(exceptionKind(template), template).toBe("booking");
    }
  });

  it("refuses a page size outside 1 to 100 and a tenant id that is not a UUID before any query", async () => {
    for (const limit of [0, -1, 1.5, MAX_EMAIL_EXCEPTIONS_PAGE + 1, Number.NaN]) {
      await expect(
        listEmailExceptions(untouched, tenantId, { limit }),
        String(limit),
      ).rejects.toThrow(RangeError);
    }
    await expect(listEmailExceptions(untouched, "not-a-tenant", { limit: 10 })).rejects.toThrow(
      TypeError,
    );
  });

  it("answers cursor_invalid for a cursor that is not a UUID, without a query", async () => {
    await expect(
      listEmailExceptions(untouched, tenantId, { limit: 10, before: "not-a-message" }),
    ).resolves.toEqual({ kind: "cursor_invalid" });
  });
});
