import { describe, expect, it } from "vitest";
import { hasTrigram, searchShape } from "./search.ts";

// Which statement a search emits (B1). This pins the routing only; whether an
// index serves the arms is proven, or not, by EXPLAIN in the integration suite.
describe("search shape", () => {
  it("finds a trigram only in a run of three ASCII letters or digits", () => {
    for (const yes of ["ern", "Smith", "o'brien", "a.bcd", "gmail", "123", "x7k3m"]) {
      expect({ yes, has: hasTrigram(yes) }).toEqual({ yes, has: true });
    }
    for (const no of ["", "ab", "a.b", "@gm", "O'B", "J-L", "a_b%c", "é é é", "Fé"]) {
      expect({ no, has: hasTrigram(no) }).toEqual({ no, has: false });
    }
  });

  it("keeps finance on the single statement, whatever the text", () => {
    for (const q of ["Smith", "7K3M9P", "gmail.com", "ab"]) {
      expect(searchShape(q, false)).toBe("single");
    }
  });

  it("uses the arms when every booker arm has a trigram", () => {
    // Name ["Luis", "Fernández"] and no email (it holds a space).
    expect(searchShape("Luis Fernández", true)).toBe("arms");
    // One word without a trigram is fine while another has one.
    expect(searchShape("Jo Smith", true)).toBe("arms");
    expect(searchShape("7K3M 9P", true)).toBe("arms");
    // One word: it is the name and the email fragment.
    expect(searchShape("smith", true)).toBe("arms");
    expect(searchShape("smith@example", true)).toBe("arms");
  });

  it("falls back to the single statement when a booker arm has none", () => {
    // Too short for any arm.
    expect(searchShape("ab", true)).toBe("single");
    // Punctuation splits every run below three.
    for (const q of ["a.b", "@gm", "O'B", "J-L", "Jo Li"]) {
      expect({ q, shape: searchShape(q, true) }).toEqual({ q, shape: "single" });
    }
    // A name arm with a trigram, but an email fragment without one, cannot
    // happen: a one-word text is both. Several words have no email arm.
    expect(searchShape("Jo-Li", true)).toBe("single");
  });
});
