import { describe, expect, it } from "vitest";
import { moneyViewFor } from "../src/routes/console-staff.ts";

// W3-G2.12-rest D3: a typed check or receipt number can name a guest, so only
// owners and booking staff read it; finance and TideGrid support, under either
// kind of grant, get the cell blank, and support sees provider ids masked.
describe("what the money report shows each role", () => {
  it("gives typed references only to owners and booking staff", () => {
    expect(moneyViewFor("owner")).toEqual({ typedReferences: true, maskProviderReferences: false });
    expect(moneyViewFor("booking_staff")).toEqual({
      typedReferences: true,
      maskProviderReferences: false,
    });
    expect(moneyViewFor("finance")).toEqual({
      typedReferences: false,
      maskProviderReferences: false,
    });
    for (const role of ["support_masked", "support_unmasked"] as const) {
      expect(moneyViewFor(role), role).toEqual({
        typedReferences: false,
        maskProviderReferences: true,
      });
    }
  });
});
