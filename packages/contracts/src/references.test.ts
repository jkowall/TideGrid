import { describe, expect, it } from "vitest";
import { BookingReference } from "./bookings.ts";
import {
  bookingReferencePattern,
  bookingReferencePrefix,
  isNumberShapedReference,
  normalizeBookingReference,
  unguardBookingReference,
} from "./references.ts";

describe("booking references", () => {
  it("reads a reference the way people type and say it", () => {
    expect(normalizeBookingReference("QKG6ERBF")).toBe("QKG6ERBF");
    expect(normalizeBookingReference("qkg6erbf")).toBe("QKG6ERBF");
    expect(normalizeBookingReference(" qkg6-erbf ")).toBe("QKG6ERBF");
    expect(normalizeBookingReference("QKG6 ERBF")).toBe("QKG6ERBF");
    // Crockford base32 reads O as zero and I and L as one.
    expect(normalizeBookingReference("C03G4ZFJ")).toBe("C03G4ZFJ");
    expect(normalizeBookingReference("CO3G4ZFJ")).toBe("C03G4ZFJ");
    expect(normalizeBookingReference("b82wizz5")).toBe("B82W1ZZ5");
    expect(normalizeBookingReference("B82WlZZ5")).toBe("B82W1ZZ5");
  });

  it("knows which references a spreadsheet would read as numbers", () => {
    for (const ref of ["01234567", "12345678", "12345E67", "00012E34", "12E45678", "1E999999"]) {
      expect(isNumberShapedReference(ref), ref).toBe(true);
    }
    for (const ref of [
      "2KVK8E6R",
      "DS00NSQJ",
      "0X1A2B3C",
      "0B101010",
      "1234567E",
      "E1234567",
      "",
    ]) {
      expect(isNumberShapedReference(ref), ref).toBe(false);
    }
  });

  it("removes one leading apostrophe and no more", () => {
    expect(unguardBookingReference("'01234567")).toBe("01234567");
    expect(unguardBookingReference("01234567")).toBe("01234567");
    expect(unguardBookingReference("''01234567")).toBe("'01234567");
  });

  it("drops a pasted leading apostrophe when reading a reference", () => {
    expect(normalizeBookingReference("'01234567")).toBe("01234567");
    expect(normalizeBookingReference("'12345E67")).toBe("12345E67");
    expect(bookingReferencePrefix("'01234567")).toBe("01234567");
    expect(bookingReferencePrefix("'0123")).toBe("0123");
  });

  it("drops spaces and hyphens before the pasted apostrophe (review on #78)", () => {
    expect(normalizeBookingReference(" '01234567 ")).toBe("01234567");
    expect(normalizeBookingReference("\t'0123-4567\n")).toBe("01234567");
    expect(bookingReferencePrefix("-'01234567")).toBe("01234567");
    expect(bookingReferencePrefix(" ' 0123")).toBe("0123");
    // Still only one apostrophe: a second one is not a reference character.
    expect(normalizeBookingReference(" ''01234567")).toBeNull();
  });

  it("refuses anything that cannot be a reference", () => {
    for (const bad of [
      "",
      "QKG6ERB",
      "QKG6ERBFX",
      "QKG6ERBU",
      "QKG6_ERBF",
      "QKG6ERB!",
      "../../x",
      "Q".repeat(65),
    ]) {
      expect(normalizeBookingReference(bad), bad).toBeNull();
    }
  });

  it("issues only what the contract and the database accept", () => {
    expect(bookingReferencePattern.test("QKG6ERBF")).toBe(true);
    expect(BookingReference.safeParse("QKG6ERBF").success).toBe(true);
    for (const letter of ["I", "L", "O", "U"]) {
      expect(bookingReferencePattern.test(`QKG6ERB${letter}`), letter).toBe(false);
    }
  });
});
