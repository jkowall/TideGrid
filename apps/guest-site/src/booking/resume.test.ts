// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { charterTripId, testNow, tripId } from "./fixtures.ts";
import {
  type BookedRecord,
  clearBooked,
  clearResume,
  type ResumeRecord,
  readBooked,
  readResume,
  saveBooked,
  saveResume,
} from "./resume.ts";

const storageKey = "tidegrid.checkout";
const sessionId = "5d0c4a1e-2b3c-4d5e-8f60-000000000001";
const quoteId = "0b7f3a52-9c1e-4d2a-8f6b-000000000001";
/** The shape of a checkout secret (43 base64url characters), made up for these tests. */
const secret = "test_secret_".padEnd(43, "x");
const minute = 60_000;
const now = testNow.getTime();
const expiry = now + 15 * minute;

const record: ResumeRecord = {
  tripId,
  sessionId,
  quoteId,
  secret,
  paymentSent: false,
  paymentTried: false,
  expiresAt: new Date(expiry).toISOString(),
  clockOffsetMs: null,
};

const stored = () => window.sessionStorage.getItem(storageKey);
const store = (value: unknown) =>
  window.sessionStorage.setItem(
    storageKey,
    typeof value === "string" ? value : JSON.stringify(value),
  );

/** The record with one field removed. */
const without = (key: keyof ResumeRecord) =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("saveResume and readResume", () => {
  it("reads back the record saved for the same trip", () => {
    saveResume(record);
    expect(readResume(tripId, now)).toEqual(record);
  });

  it("keeps whether a payment was sent", () => {
    saveResume({ ...record, paymentSent: true, paymentTried: true });
    expect(readResume(tripId, now)?.paymentSent).toBe(true);
  });

  it("keeps whether a payment was tried, and counts a sent one as tried", () => {
    saveResume({ ...record, paymentTried: true });
    expect(readResume(tripId, now)).toMatchObject({ paymentSent: false, paymentTried: true });
    saveResume({ ...record, paymentSent: true, paymentTried: false });
    expect(readResume(tripId, now)?.paymentTried).toBe(true);
  });

  it("keeps the server clock's offset, and drops one no device could have", () => {
    saveResume({ ...record, clockOffsetMs: -45 * minute });
    expect(readResume(tripId, now)?.clockOffsetMs).toBe(-45 * minute);
    store({ ...record, clockOffsetMs: 30 * 24 * 60 * minute });
    expect(readResume(tripId, now)?.clockOffsetMs).toBeNull();
    store({ ...record, clockOffsetMs: "fast" });
    expect(readResume(tripId, now)?.clockOffsetMs).toBeNull();
  });

  it("matches the trip whatever the case of its id", () => {
    saveResume(record);
    expect(readResume(tripId.toUpperCase(), now)).toEqual(record);
  });

  it("gives another trip nothing, and keeps the record for its own", () => {
    saveResume(record);
    expect(readResume(charterTripId, now)).toBeNull();
    expect(stored()).not.toBeNull();
    expect(readResume(tripId, now)).toEqual(record);
  });

  it("reads nothing when nothing is saved", () => {
    expect(readResume(tripId, now)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps one record: a new checkout replaces the last", () => {
    saveResume(record);
    const next = { ...record, sessionId: "5d0c4a1e-2b3c-4d5e-8f60-000000000002" };
    saveResume(next);
    expect(window.sessionStorage.length).toBe(1);
    expect(readResume(tripId, now)).toEqual(next);
  });

  it("stores the ids, the secret, two flags, and the clock in this tab's session storage, and no more", () => {
    saveResume(record);
    expect(Object.keys(JSON.parse(stored() ?? "{}")).sort()).toEqual([
      "clockOffsetMs",
      "expiresAt",
      "paymentSent",
      "paymentTried",
      "quoteId",
      "secret",
      "sessionId",
      "tripId",
    ]);
    expect(window.localStorage.length).toBe(0);
  });
});

describe("a record that cannot be trusted", () => {
  const bad: Array<[string, unknown]> = [
    ["malformed JSON", "{not json"],
    ["JSON null", "null"],
    ["a JSON string", '"text"'],
    ["a JSON array", "[]"],
    ["a secret that is too short", { ...record, secret: "short" }],
    ["a secret that is too long", { ...record, secret: `${secret}x` }],
    ["a secret with a character outside base64url", { ...record, secret: `+${secret.slice(1)}` }],
    ["a secret that is not a string", { ...record, secret: 43 }],
    ["a trip id that is not a UUID", { ...record, tripId: "not-a-uuid" }],
    ["a session id that is not a UUID", { ...record, sessionId: "not-a-uuid" }],
    ["a quote id that is not a UUID", { ...record, quoteId: "not-a-uuid" }],
    ["a quote id that is empty", { ...record, quoteId: "" }],
    ["a missing quote id", without("quoteId")],
    ["a missing session id", without("sessionId")],
    ["a missing secret", without("secret")],
    ["a payment flag that is not a boolean", { ...record, paymentSent: "no" }],
    ["a missing payment flag", without("paymentSent")],
    ["a tried flag that is not a boolean", { ...record, paymentTried: 1 }],
    ["a missing tried flag", without("paymentTried")],
    ["an expiry that is not a date", { ...record, expiresAt: "soon" }],
    ["an expiry that is not a string", { ...record, expiresAt: expiry }],
  ];

  it.each(bad)("is removed on read: %s", (_name, value) => {
    store(value);
    expect(readResume(tripId, now)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("is removed when read for another trip, too", () => {
    store("{not json");
    expect(readResume(charterTripId, now)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("is still reported as nothing when it cannot be removed", () => {
    store("{not json");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readResume(tripId, now)).toBeNull();
  });
});

describe("a record past its checkout's expiry", () => {
  it("is kept up to 10 minutes after the expiry, so a late reload can read the outcome", () => {
    saveResume(record);
    expect(readResume(tripId, now)).toEqual(record);
    expect(readResume(tripId, expiry)).toEqual(record);
    expect(readResume(tripId, expiry + 10 * minute - 1)).toEqual(record);
    expect(stored()).not.toBeNull();
  });

  it("is kept at exactly 10 minutes after the expiry", () => {
    saveResume(record);
    expect(readResume(tripId, expiry + 10 * minute)).toEqual(record);
  });

  it("is removed once it is more than 10 minutes past", () => {
    saveResume(record);
    expect(readResume(tripId, expiry + 10 * minute + 1)).toBeNull();
    expect(stored()).toBeNull();
    expect(readResume(tripId, now)).toBeNull();
  });

  it("is removed when read for another trip, too", () => {
    saveResume(record);
    expect(readResume(charterTripId, expiry + 11 * minute)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("ages on the server's clock it learned, so a fast device keeps a live record", () => {
    // The device runs 45 minutes fast: by its clock the expiry is 30 minutes past.
    const fast = { ...record, clockOffsetMs: -45 * minute };
    saveResume(fast);
    expect(readResume(tripId, now + 45 * minute)).toEqual(fast);
    expect(stored()).not.toBeNull();
    // On the server's clock it ages as any other: removed once 10 minutes past.
    expect(readResume(tripId, expiry + 45 * minute + 10 * minute + 1)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("ages on the server's clock for a slow device too", () => {
    const slow = { ...record, clockOffsetMs: 20 * minute };
    saveResume(slow);
    // By the device's clock only 5 minutes past the expiry; by the server's, 25.
    expect(readResume(tripId, expiry + 5 * minute)).toBeNull();
  });

  it("reads the clock when no time is given", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    saveResume(record);
    vi.setSystemTime(expiry + 5 * minute);
    expect(readResume(tripId)).toEqual(record);
    vi.setSystemTime(expiry + 11 * minute);
    expect(readResume(tripId)).toBeNull();
    expect(stored()).toBeNull();
  });
});

describe("clearResume", () => {
  it("removes the record", () => {
    saveResume(record);
    clearResume();
    expect(stored()).toBeNull();
    expect(readResume(tripId, now)).toBeNull();
  });

  it("removes it whichever trip it was for", () => {
    saveResume({ ...record, tripId: charterTripId });
    clearResume();
    expect(stored()).toBeNull();
  });

  it("does nothing when there is no record", () => {
    expect(() => clearResume()).not.toThrow();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("leaves other storage alone", () => {
    window.sessionStorage.setItem("other", "kept");
    saveResume(record);
    clearResume();
    expect(window.sessionStorage.getItem("other")).toBe("kept");
  });
});

describe("storage that fails", () => {
  it("does not throw, and reads nothing, when sessionStorage cannot be reached", () => {
    const access = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    expect(() => saveResume(record)).not.toThrow();
    expect(readResume(tripId, now)).toBeNull();
    expect(() => clearResume()).not.toThrow();
    expect(access).toHaveBeenCalled();
  });

  it("does not throw when storage is full or blocked on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    expect(() => saveResume(record)).not.toThrow();
    expect(stored()).toBeNull();
  });

  it("reads nothing, without throwing, when a read is blocked", () => {
    saveResume(record);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readResume(tripId, now)).toBeNull();
  });

  it("does not throw when a removal is blocked", () => {
    saveResume(record);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => clearResume()).not.toThrow();
  });
});

describe("the last confirmation", () => {
  const booked: BookedRecord = {
    tripId,
    reference: "C03G4ZFJ",
    productName: "Sunset Harbor Cruise",
    when: "Wednesday, October 7, 2026 at 6:00 PM",
    where: "Harbor Marina, Dock C",
    meetAt: "Dock C, slip 14",
    party: "3 guests: 2 Adult, 1 Child (3 to 12)",
    extras: "Souvenir photo × 1, Drink voucher × 2",
    total: 14_821,
  };
  const bookedText = () => window.sessionStorage.getItem("tidegrid.booked");

  it("reads back what the confirmation said, for its own trip only", () => {
    saveBooked(booked);
    expect(readBooked(tripId)).toEqual(booked);
    expect(readBooked(tripId.toUpperCase())).toEqual(booked);
    expect(readBooked(charterTripId)).toBeNull();
  });

  it("holds no secret and no name or email: only what the screen showed", () => {
    saveBooked(booked);
    expect(Object.keys(JSON.parse(bookedText() ?? "{}")).sort()).toEqual([
      "extras",
      "meetAt",
      "party",
      "productName",
      "reference",
      "total",
      "tripId",
      "when",
      "where",
    ]);
    expect(window.localStorage.length).toBe(0);
  });

  it("lives beside an open checkout's record without touching it", () => {
    saveResume(record);
    saveBooked(booked);
    clearResume();
    expect(readBooked(tripId)).toEqual(booked);
  });

  const bad: Array<[string, Partial<Record<keyof BookedRecord, unknown>>]> = [
    ["a reference of the wrong shape", { reference: "c03g4zfj" }],
    ["a reference with a letter the alphabet leaves out", { reference: "C03G4ZFI" }],
    ["a total that is not whole cents", { total: 148.21 }],
    ["a total below zero", { total: -1 }],
    ["an empty party", { party: "" }],
    ["a trip name that is far too long", { productName: "x".repeat(201) }],
    ["a meeting point that is not text", { meetAt: 7 }],
    ["a trip id that is not a UUID", { tripId: "trip" }],
  ];
  it.each(bad)("is not shown when it holds %s", (_name, change) => {
    window.sessionStorage.setItem("tidegrid.booked", JSON.stringify({ ...booked, ...change }));
    expect(readBooked(tripId)).toBeNull();
  });

  it("takes no extras, place, or meeting point as none", () => {
    saveBooked({ ...booked, extras: null, where: null, meetAt: null });
    expect(readBooked(tripId)).toMatchObject({ extras: null, where: null, meetAt: null });
  });

  it("reads nothing from text that is not a record", () => {
    window.sessionStorage.setItem("tidegrid.booked", "{not json");
    expect(readBooked(tripId)).toBeNull();
  });

  it("is forgotten when a new checkout opens for its trip, and kept for another trip's", () => {
    saveBooked(booked);
    clearBooked(charterTripId);
    expect(readBooked(tripId)).toEqual(booked);
    clearBooked(tripId.toUpperCase());
    expect(bookedText()).toBeNull();
    expect(() => clearBooked(tripId)).not.toThrow();
  });
});
