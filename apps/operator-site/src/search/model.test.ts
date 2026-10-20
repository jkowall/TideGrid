// @vitest-environment jsdom

import { bookingReferencePrefix } from "@tidegrid/contracts/references";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tenantId } from "../bookings/fixtures.ts";
import {
  criteriaOf,
  firstSearchDate,
  forgetSearches,
  lastSearchDate,
  recallSearch,
  referencePrefix,
  rememberSearch,
  type SearchForm,
  sameCriteria,
  termsText,
} from "./model.ts";

/** U+00A0, a space a person can paste from a document. */
const nbsp = String.fromCharCode(0x00a0);
const otherTenantId = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02";

const form = (over: Partial<SearchForm> = {}): SearchForm => ({
  text: "",
  from: "",
  to: "",
  ...over,
});

describe("the start of a booking reference", () => {
  it.each([
    ["QKG6", "QKG6"],
    ["qkg6", "QKG6"],
    ["Qkg6-Erb-F", "QKG6ERBF"],
    ["qkg 6", "QKG6"],
    ["QKG-6ERB", "QKG6ERB"],
    ["  q k g - 6  ", "QKG6"],
    [`QK${nbsp}G6`, "QKG6"],
    ["QK\tG6", "QKG6"],
  ])("reads %j as %s, ignoring case, spaces, and hyphens", (typed, read) => {
    expect(referencePrefix(typed)).toBe(read);
  });

  it.each([
    ["QKGO", "QKG0"],
    ["QKGI", "QKG1"],
    ["qkgl", "QKG1"],
    ["oil", "011"],
    ["7HM2P9TW", "7HM2P9TW"],
  ])("reads %j as %s: O is 0, and I and L are 1", (typed, read) => {
    expect(referencePrefix(typed)).toBe(read);
  });

  it("takes every letter a reference holds, and refuses U", () => {
    const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    const refused = letters.filter((letter) => referencePrefix(`${letter}${letter}`) === null);
    expect(refused).toEqual(["U"]);
    expect(referencePrefix("QKG6U")).toBeNull();
    expect(referencePrefix("u7")).toBeNull();
  });

  it.each([
    ["", null],
    ["-", null],
    ["Q", null],
    [" q ", null],
    ["QK", "QK"],
    ["QKG6ERBF", "QKG6ERBF"],
    ["QKG6ERBF7", null],
    // Hyphens and spaces are not characters of the reference.
    ["QKG6-ERBF", "QKG6ERBF"],
    ["QKG6 ERBF 7", null],
  ])("holds %j to two to eight characters: %j", (typed, read) => {
    expect(referencePrefix(typed)).toBe(read);
  });

  it.each([
    "QKG.6",
    "QK+G6",
    "QKG@",
    "QKGé",
    "maya.okonkwo@guest.example",
    "Maya Okonkwo",
    "Luis Fernandez",
  ])("refuses %j, which is not the start of a reference", (typed) => {
    expect(referencePrefix(typed)).toBeNull();
  });

  it("is the API's own reader, from the shared references module", () => {
    expect(referencePrefix).toBe(bookingReferencePrefix);
    // Past 64 characters nothing is read, as the API reads nothing.
    expect(referencePrefix(`QK${" ".repeat(70)}G6`)).toBeNull();
  });
});

describe("what a search may ask of an owner or booking staff", () => {
  const staff = (over: Partial<SearchForm>) => criteriaOf(form(over), true);

  it("names the three things to give when nothing is given", () => {
    const problem = "Enter a name, an email, or a booking reference, or choose dates.";
    expect(staff({})).toEqual({ kind: "invalid", problems: { text: problem } });
    expect(staff({ text: "   ", from: " ", to: "" })).toEqual({
      kind: "invalid",
      problems: { text: problem },
    });
  });

  it("wants at least 2 and at most 120 characters of text, counted after trimming", () => {
    expect(staff({ text: "m" })).toEqual({
      kind: "invalid",
      problems: { text: "Enter at least 2 characters." },
    });
    expect(staff({ text: "  m  " })).toEqual({
      kind: "invalid",
      problems: { text: "Enter at least 2 characters." },
    });
    expect(staff({ text: "ma" }).kind).toBe("ok");
    expect(staff({ text: "a".repeat(120) }).kind).toBe("ok");
    expect(staff({ text: `  ${"a".repeat(120)}  ` }).kind).toBe("ok");
    expect(staff({ text: "a".repeat(121) })).toEqual({
      kind: "invalid",
      problems: { text: "Enter at most 120 characters." },
    });
  });

  it("asks for the text as typed, trimmed, whatever it is", () => {
    for (const text of ["Maya Okonkwo", "okonkwo maya", "maya.okonkwo@guest.example", "QKG6"]) {
      expect(staff({ text: `  ${text}  ` })).toStrictEqual({ kind: "ok", criteria: { q: text } });
    }
  });

  it("leaves out what was not given, rather than sending it empty", () => {
    expect(staff({ from: "2026-11-04" })).toStrictEqual({
      kind: "ok",
      criteria: { from: "2026-11-04" },
    });
    expect(staff({ to: "2026-11-30" })).toStrictEqual({
      kind: "ok",
      criteria: { to: "2026-11-30" },
    });
    expect(staff({ text: "  ", from: "2026-11-04" })).toStrictEqual({
      kind: "ok",
      criteria: { from: "2026-11-04" },
    });
  });

  it("takes text with both dates", () => {
    expect(staff({ text: "maya", from: "2026-11-01", to: "2026-11-30" })).toStrictEqual({
      kind: "ok",
      criteria: { q: "maya", from: "2026-11-01", to: "2026-11-30" },
    });
  });

  it("takes dates from 2000 to 2099, both edges included", () => {
    expect(firstSearchDate).toBe("2000-01-01");
    expect(lastSearchDate).toBe("2099-12-31");
    expect(staff({ from: "2000-01-01", to: "2099-12-31" }).kind).toBe("ok");
    const problem = "Enter a date from 2000 to 2099.";
    expect(staff({ from: "1999-12-31" })).toEqual({ kind: "invalid", problems: { from: problem } });
    expect(staff({ to: "2100-01-01" })).toEqual({ kind: "invalid", problems: { to: problem } });
    expect(staff({ from: "0001-01-01", to: "9999-12-31" })).toEqual({
      kind: "invalid",
      problems: { from: problem, to: problem },
    });
  });

  it.each(["2026-02-30", "2026-13-01", "2026-1-5", "2026-11-04T10:00", "soon"])(
    "refuses %j as a date, in either field",
    (date) => {
      const problem = "Enter a date from 2000 to 2099.";
      expect(staff({ from: date })).toEqual({ kind: "invalid", problems: { from: problem } });
      expect(staff({ to: date })).toEqual({ kind: "invalid", problems: { to: problem } });
    },
  );

  it("takes the same day twice, and refuses a last date before the first", () => {
    expect(staff({ from: "2026-11-04", to: "2026-11-04" }).kind).toBe("ok");
    expect(staff({ from: "2026-11-03", to: "2026-11-04" }).kind).toBe("ok");
    expect(staff({ from: "2026-11-05", to: "2026-11-04" })).toEqual({
      kind: "invalid",
      problems: { to: "The last date is before the first." },
    });
  });

  it("says nothing of the order when a date is itself refused", () => {
    expect(staff({ from: "2026-11-10", to: "1999-01-01" })).toEqual({
      kind: "invalid",
      problems: { to: "Enter a date from 2000 to 2099." },
    });
    expect(staff({ from: "2100-01-01", to: "2026-11-04" })).toEqual({
      kind: "invalid",
      problems: { from: "Enter a date from 2000 to 2099." },
    });
  });

  it("reports every problem at once, so one pass fixes them all", () => {
    expect(staff({ text: "m", from: "soon", to: "later" })).toEqual({
      kind: "invalid",
      problems: {
        text: "Enter at least 2 characters.",
        from: "Enter a date from 2000 to 2099.",
        to: "Enter a date from 2000 to 2099.",
      },
    });
  });

  it("does not ask for text when dates are given, and does not flag text that is fine", () => {
    expect(staff({ text: "maya", from: "soon" })).toEqual({
      kind: "invalid",
      problems: { from: "Enter a date from 2000 to 2099." },
    });
  });
});

describe("what a search may ask of finance", () => {
  const finance = (over: Partial<SearchForm>) => criteriaOf(form(over), false);

  it("names what to give in its own words when nothing is given", () => {
    expect(finance({})).toEqual({
      kind: "invalid",
      problems: { text: "Enter a booking reference, or choose dates." },
    });
  });

  it("takes the start of a reference, sent as typed so the API reads it the same way", () => {
    expect(finance({ text: "QKG6" })).toStrictEqual({ kind: "ok", criteria: { q: "QKG6" } });
    expect(finance({ text: "  qkg 6  " })).toStrictEqual({ kind: "ok", criteria: { q: "qkg 6" } });
    expect(finance({ text: "qkg-o" })).toStrictEqual({ kind: "ok", criteria: { q: "qkg-o" } });
    expect(finance({ text: "QKG6ERBF" }).kind).toBe("ok");
  });

  it.each([
    ["a name", "Maya Okonkwo"],
    ["an email", "maya.okonkwo@guest.example"],
    ["a letter a reference never holds", "QKG6U"],
    ["more than eight characters", "QKG6ERBF7"],
    ["punctuation", "QKG.6"],
  ])("refuses %s, and says why and what to do", (_what, text) => {
    expect(finance({ text })).toEqual({
      kind: "invalid",
      problems: {
        text: "Enter the start of a booking reference, such as QKG6. Your role searches by reference and date only.",
      },
    });
  });

  it("holds text to the length rules before the reference rule", () => {
    expect(finance({ text: "Q" })).toEqual({
      kind: "invalid",
      problems: { text: "Enter at least 2 characters." },
    });
    expect(finance({ text: "A".repeat(121) })).toEqual({
      kind: "invalid",
      problems: { text: "Enter at most 120 characters." },
    });
  });

  it("takes dates alone, and a reference with dates", () => {
    expect(finance({ from: "2026-11-04", to: "2026-11-30" })).toStrictEqual({
      kind: "ok",
      criteria: { from: "2026-11-04", to: "2026-11-30" },
    });
    expect(finance({ text: "QKG6", from: "2026-11-04" })).toStrictEqual({
      kind: "ok",
      criteria: { q: "QKG6", from: "2026-11-04" },
    });
  });

  it("holds dates to the same rules as everyone", () => {
    expect(finance({ from: "2026-11-05", to: "2026-11-04" })).toEqual({
      kind: "invalid",
      problems: { to: "The last date is before the first." },
    });
    expect(finance({ text: "QKG6", from: "1999-12-31" })).toEqual({
      kind: "invalid",
      problems: { from: "Enter a date from 2000 to 2099." },
    });
  });
});

describe("searches compared, and named", () => {
  it("takes two searches as the same when they ask the same, however the form was typed", () => {
    const asked = (over: Partial<SearchForm>) => {
      const result = criteriaOf(form(over), true);
      return result.kind === "ok" ? result.criteria : null;
    };
    expect(sameCriteria(asked({ text: "maya" }), asked({ text: "  maya " }))).toBe(true);
    expect(sameCriteria(asked({ text: "maya" }), asked({ text: "Maya" }))).toBe(false);
    expect(sameCriteria(asked({ from: "2026-11-01" }), asked({ to: "2026-11-01" }))).toBe(false);
    expect(sameCriteria(asked({ text: "maya" }), asked({ text: "maya", to: "2026-11-30" }))).toBe(
      false,
    );
    expect(sameCriteria(null, asked({ text: "maya" }))).toBe(false);
    expect(sameCriteria(asked({ text: "maya" }), null)).toBe(false);
  });

  it.each([
    [{ q: "maya" }, "Matching “maya”."],
    [
      { q: "QKG6", from: "2026-11-01", to: "2026-11-30" },
      "Matching “QKG6”, departing Nov 1 to 30, 2026.",
    ],
    [{ from: "2026-12-28", to: "2027-01-03" }, "Departing Dec 28, 2026 to Jan 3, 2027."],
    [{ from: "2026-11-04", to: "2026-11-04" }, "Departing Nov 4, 2026."],
    [{ from: "2026-11-04" }, "Departing on or after Nov 4, 2026."],
    [{ to: "2026-11-04" }, "Departing on or before Nov 4, 2026."],
  ])("names %j in words", (criteria, words) => {
    expect(termsText(criteria)).toBe(words);
  });
});

describe("the last search each operator ran", () => {
  beforeEach(forgetSearches);
  afterEach(forgetSearches);

  it("has nothing until a search is remembered", () => {
    expect(recallSearch(tenantId)).toBeUndefined();
    expect(recallSearch(otherTenantId)).toBeUndefined();
  });

  it("hands back what an operator ran, and nothing to another operator", () => {
    rememberSearch(tenantId, form({ text: "maya", from: "2026-11-01" }));
    expect(recallSearch(tenantId)).toEqual({ text: "maya", from: "2026-11-01", to: "" });
    expect(recallSearch(otherTenantId)).toBeUndefined();
    rememberSearch(otherTenantId, form({ text: "QKG6" }));
    expect(recallSearch(otherTenantId)).toEqual({ text: "QKG6", from: "", to: "" });
    expect(recallSearch(tenantId)?.text).toBe("maya");
  });

  it("keeps only the latest search of an operator", () => {
    rememberSearch(tenantId, form({ text: "maya" }));
    rememberSearch(tenantId, form({ text: "luis", to: "2026-11-30" }));
    expect(recallSearch(tenantId)).toEqual({ text: "luis", from: "", to: "2026-11-30" });
  });

  it("hands back a copy, so changing it, or the form it came from, changes nothing remembered", () => {
    const typed = form({ text: "maya" });
    rememberSearch(tenantId, typed);
    typed.text = "changed after";
    const recalled = recallSearch(tenantId);
    expect(recalled?.text).toBe("maya");
    expect(recalled).not.toBe(recallSearch(tenantId));
    if (recalled) recalled.text = "changed after recall";
    expect(recallSearch(tenantId)?.text).toBe("maya");
  });

  it("remembers an emptied form as empty, which is not the same as nothing", () => {
    rememberSearch(tenantId, form({ text: "maya" }));
    rememberSearch(tenantId, form());
    expect(recallSearch(tenantId)).toEqual({ text: "", from: "", to: "" });
  });

  it("forgets every operator's search at once", () => {
    rememberSearch(tenantId, form({ text: "maya" }));
    rememberSearch(otherTenantId, form({ text: "luis" }));
    forgetSearches();
    expect(recallSearch(tenantId)).toBeUndefined();
    expect(recallSearch(otherTenantId)).toBeUndefined();
  });
});
