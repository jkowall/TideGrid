import { describe, expect, it } from "vitest";
import { extrasOf, maskProviderReference, offsetDateTime, partyOf, sumByCode } from "./console.ts";

describe("console reads: pure helpers", () => {
  it("masks a provider payment id to its prefix and last four characters", () => {
    expect(maskProviderReference("fpay_ABCDEFGHIJKLMNOPQRSThGvm")).toBe("fpay_••••hGvm");
    expect(maskProviderReference("pi_3NkAbCdEfGhIjKlMnOp9Z")).toBe("pi_••••Op9Z");
    expect(maskProviderReference("re_3NkAbCdEfGhIjKlMn")).toBe("re_••••KlMn");
    // Too short to show a tail without giving most of it away.
    expect(maskProviderReference("fpay_ABCDEFG")).toBe("fpay_••••");
    // No provider prefix, or one too long to be a prefix.
    expect(maskProviderReference("ABCDEFGHIJKLMNOP")).toBe("••••MNOP");
    expect(maskProviderReference("averylongprefix_ABCDEFGHIJKLMNOP")).toBe("••••MNOP");
    expect(maskProviderReference(null)).toBeNull();
    expect(maskProviderReference("")).toBeNull();
  });

  it("never returns the whole id", () => {
    const ref = "fpay_ABCDEFGHIJKLMNOPQRSThGvm";
    const masked = maskProviderReference(ref) ?? "";
    expect(masked).not.toContain("ABCDEFGH");
    expect(masked.length).toBeLessThan(ref.length);
  });

  it("reads a shared-seat party from its ticket lines and a charter from its guests", () => {
    expect(
      partyOf("shared_seat", 3, [
        { code: "adult", name: "Adult", quantity: 2 },
        { code: "child", name: "Child (3 to 12)", quantity: 1 },
      ]),
    ).toEqual({
      kind: "tickets",
      guests: 3,
      tickets: [
        { code: "adult", name: "Adult", quantity: 2 },
        { code: "child", name: "Child (3 to 12)", quantity: 1 },
      ],
    });
    expect(
      partyOf("private_charter", 8, [
        { code: "charter", name: "Whole boat, up to 12 guests", quantity: 1 },
      ]),
    ).toEqual({ kind: "charter", guests: 8, charter: "Whole boat, up to 12 guests" });
    expect(partyOf("private_charter", 4, [])).toEqual({
      kind: "charter",
      guests: 4,
      charter: "Private charter",
    });
  });

  it("lists extras and sums them by code in the order they first appear", () => {
    const lines = [
      { code: "photo", name: "Souvenir photo", quantity: 1 },
      { code: "drinks", name: "Drink voucher", quantity: 2 },
    ];
    expect(extrasOf(lines)).toEqual(lines);
    expect(sumByCode([...lines, { code: "photo", name: "Souvenir photo", quantity: 2 }])).toEqual([
      { code: "photo", name: "Souvenir photo", quantity: 3 },
      { code: "drinks", name: "Drink voucher", quantity: 2 },
    ]);
    // Summing never changes the inputs.
    expect(lines[0]?.quantity).toBe(1);
  });

  it("writes a local time with the stored offset, as the catalog does", () => {
    expect(offsetDateTime("2026-10-06T23:30:00.000Z", -240)).toBe("2026-10-06T19:30:00-04:00");
    expect(offsetDateTime(new Date("2026-11-02T00:30:00Z"), -300)).toBe(
      "2026-11-01T19:30:00-05:00",
    );
    expect(offsetDateTime("2026-10-06T17:30:00Z", -600)).toBe("2026-10-06T07:30:00-10:00");
    expect(offsetDateTime("2026-10-06T17:30:00Z", 330)).toBe("2026-10-06T23:00:00+05:30");
    expect(offsetDateTime("2026-10-06T17:30:00Z", 0)).toBe("2026-10-06T17:30:00+00:00");
  });
});
