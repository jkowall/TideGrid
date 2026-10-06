import { describe, expect, it } from "vitest";
import { BookingReference } from "./bookings.ts";
import { bookingReferencePattern, normalizeBookingReference } from "./references.ts";

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
