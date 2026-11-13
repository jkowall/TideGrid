import { describe, expect, it } from "vitest";
import { dockDisplayName, lastNameMatches, normalizeBookingCode } from "./dock.ts";

describe("the dock lookup's comparisons", () => {
  it("folds a typed booking code the way codes are written", () => {
    expect(normalizeBookingCode(" 7k3m-9pqr ")).toBe("7K3M9PQR");
    expect(normalizeBookingCode("O1IL")).toBe("0111");
    expect(normalizeBookingCode("ab_cd.ef")).toBe("ABCDEF");
    expect(normalizeBookingCode("")).toBeNull();
    expect(normalizeBookingCode("#!?")).toBeNull();
    expect(normalizeBookingCode("A".repeat(17))).toBeNull();
  });

  it("matches the last word or words of the booker's name, forgiving case and accents", () => {
    expect(lastNameMatches("Ana María Muñoz", "munoz")).toBe(true);
    expect(lastNameMatches("Ana María Muñoz", "MUÑOZ")).toBe(true);
    expect(lastNameMatches("Juan de la Cruz", "de la Cruz")).toBe(true);
    expect(lastNameMatches("Juan de la Cruz", "Cruz")).toBe(true);
    expect(lastNameMatches("Mary O'Brien", "O'Brien")).toBe(true);
    expect(lastNameMatches("Mary O'Brien", "o brien")).toBe(true);
    expect(lastNameMatches("Mary O'Brien", "Mary O'Brien")).toBe(false);
    expect(lastNameMatches("Mary O'Brien", "Brie")).toBe(false);
    expect(lastNameMatches("Lee Wu", "u")).toBe(false);
    expect(lastNameMatches("Lee Wu", "")).toBe(false);
    expect(lastNameMatches("Madonna", "Madonna")).toBe(false);
  });

  it("forgives punctuation, suffixes, name order, and common spellings", () => {
    const yes: [string, string][] = [
      ["Pat O'Brien", "OBrien"],
      ["Pat OBrien", "O'Brien"],
      ["Mary Smith-Jones", "SmithJones"],
      ["Mary Smith-Jones", "Smith Jones"],
      ["Mary Smith-Jones", "Smith"],
      ["Mary Smith-Jones", "Jones"],
      ["John Mc Donald", "McDonald"],
      ["John Smith Jr.", "Smith"],
      ["John Smith III", "Smith"],
      ["Dr. Ana Ruiz PhD", "Ruiz"],
      ["Smith, John", "Smith"],
      ["Hans Müller", "Mueller"],
      ["Hans Müller", "Muller"],
      ["Hans Mueller", "Müller"],
      ["Lars Sørensen", "Sorensen"],
      ["Rolf Strauß", "Strauss"],
    ];
    for (const [booker, typed] of yes)
      expect([booker, typed, lastNameMatches(booker, typed)]).toEqual([booker, typed, true]);
    const no: [string, string][] = [
      ["John Smith Jr.", "Jr"],
      ["John Smith III", "III"],
      ["Smith, John", "John"],
      ["Mary Smith-Jones", "Mary"],
      ["Pat O'Brien", "PatOBrien"],
      ["Hans Müller", "Hans"],
    ];
    for (const [booker, typed] of no)
      expect([booker, typed, lastNameMatches(booker, typed)]).toEqual([booker, typed, false]);
  });

  it("shows a first name and an initial", () => {
    expect(dockDisplayName("Ana María Muñoz")).toBe("Ana M.");
    expect(dockDisplayName("  Kid   Ögren ")).toBe("Kid Ö.");
    expect(dockDisplayName("Cher")).toBe("Cher");
  });
});
