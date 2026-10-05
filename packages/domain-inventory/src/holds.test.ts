import type { TenantContext, TenantTransaction } from "@tidegrid/database";
import { describe, expect, it } from "vitest";
import {
  acquireHold,
  confirmHold,
  DEFAULT_HOLD_TTL_SECONDS,
  expireDueHolds,
  getHold,
  getTripCapacity,
  isOwnerRef,
  listTripHolds,
  MAX_HOLD_TTL_SECONDS,
  MIN_HOLD_TTL_SECONDS,
  releaseHold,
} from "./index.ts";

/** A transaction that fails the test if anything touches it. */
const untouchable = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the transaction was used (${String(property)})`);
    },
  },
) as TenantTransaction;

const ctx: TenantContext = {
  tenantId: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01",
  actorType: "system",
  actorId: "unit",
};
const tripId = "11111111-2222-4333-8444-555555555555";

describe("owner references", () => {
  it("accept <type>:<id> and nothing looser", () => {
    for (const ok of [
      "checkout_session:7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01",
      "staff_booking:42",
      "a:b",
      `x${"y".repeat(39)}:${"z".repeat(200)}`,
    ]) {
      expect({ ok, valid: isOwnerRef(ok) }).toEqual({ ok, valid: true });
    }
    for (const bad of [
      "",
      "checkout",
      ":id",
      "Checkout:1",
      "1checkout:1",
      "checkout-session:1",
      "checkout:",
      "checkout:has space",
      "checkout:new\nline",
      `x${"y".repeat(40)}:1`,
      `x:${"z".repeat(201)}`,
      42,
      null,
    ]) {
      expect({ bad, valid: isOwnerRef(bad) }).toEqual({ bad, valid: false });
    }
  });
});

describe("hold lifetimes", () => {
  it("default inside the allowed range, which stays within the database's hour", () => {
    expect(MIN_HOLD_TTL_SECONDS).toBe(60);
    expect(MAX_HOLD_TTL_SECONDS).toBe(3600);
    expect(DEFAULT_HOLD_TTL_SECONDS).toBeGreaterThanOrEqual(MIN_HOLD_TTL_SECONDS);
    expect(DEFAULT_HOLD_TTL_SECONDS).toBeLessThanOrEqual(MAX_HOLD_TTL_SECONDS);
  });
});

describe("input checks run before the database", () => {
  const acquire = (input: Partial<Parameters<typeof acquireHold>[2]>) =>
    acquireHold(untouchable, ctx, {
      ownerRef: "checkout_session:1",
      tripId,
      partySize: 2,
      ttlSeconds: 600,
      ...input,
    });

  it("throws on programmer errors in acquisition", async () => {
    await expect(acquire({ ownerRef: "nope" })).rejects.toThrow(TypeError);
    await expect(acquire({ partySize: 2.5 })).rejects.toThrow(TypeError);
    await expect(acquire({ partySize: Number.NaN })).rejects.toThrow(TypeError);
    await expect(acquire({ ttlSeconds: 59 })).rejects.toThrow(RangeError);
    await expect(acquire({ ttlSeconds: 3601 })).rejects.toThrow(RangeError);
    await expect(acquire({ ttlSeconds: 120.5 })).rejects.toThrow(RangeError);
  });

  it("answers trip_not_found for a malformed trip id", async () => {
    expect(await acquire({ tripId: "not-a-uuid" })).toEqual({ kind: "trip_not_found" });
    expect(await acquire({ tripId: "7D1E5B3A-1C2F-4A8E-9B61-0A1C2E3F4A01" })).toEqual({
      kind: "trip_not_found",
    });
  });

  it("answers not_found for malformed hold ids and owners", async () => {
    const holdId = "11111111-2222-4333-8444-555555555555";
    expect(await confirmHold(untouchable, ctx, { holdId: "x", ownerRef: "a:b" })).toEqual({
      kind: "not_found",
    });
    expect(await confirmHold(untouchable, ctx, { holdId, ownerRef: "bad" })).toEqual({
      kind: "not_found",
    });
    expect(await releaseHold(untouchable, ctx, { holdId: "x", ownerRef: "a:b" })).toEqual({
      kind: "not_found",
    });
    expect(await getHold(untouchable, ctx.tenantId, "x")).toBeNull();
    expect(await getTripCapacity(untouchable, ctx.tenantId, "x")).toBeNull();
    expect(await listTripHolds(untouchable, ctx.tenantId, "x")).toEqual([]);
  });

  it("validates a release reason and an expiry batch size", async () => {
    const holdId = "11111111-2222-4333-8444-555555555555";
    for (const reason of ["", "x".repeat(501), "line\nbreak"]) {
      await expect(
        releaseHold(untouchable, ctx, { holdId, ownerRef: "a:b", reason }),
      ).rejects.toThrow(RangeError);
    }
    for (const limit of [0, 1001, 1.5]) {
      await expect(expireDueHolds(untouchable, ctx, { limit })).rejects.toThrow(RangeError);
    }
  });
});
