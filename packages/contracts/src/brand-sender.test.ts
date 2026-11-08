import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BrandConfig,
  contactEmailProblem,
  sameSenderName,
  senderDisplayName,
  senderNameProblem,
  senderSkeleton,
} from "./brand.ts";

/** A brand that passes, with one field changed. */
const base = {
  name: "Demo Harbor Charters",
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  contact: { email: "hello@demo-harbor.test", phone: "+13055550142" },
  legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
  locale: "en-US",
  capabilities: [],
};
const accepts = (patch: Record<string, unknown>) =>
  BrandConfig.safeParse({ ...base, ...patch }).success;

describe("the sender name rule (W1-SENDER-GUARD)", () => {
  it("keeps the synthetic brands and ordinary operator names", () => {
    for (const file of ["demo-harbor", "demo-reef"]) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../../../config/tenants/${file}.json`, import.meta.url), "utf8"),
      ) as { displayName: string; brand: { name: string } };
      expect(senderNameProblem(manifest.brand.name)).toBeNull();
      expect(sameSenderName(manifest.brand.name, manifest.displayName)).toBe(true);
      expect(senderDisplayName(manifest.brand.name)).toBe(`${manifest.brand.name} via TideGrid`);
    }
    for (const name of [
      "Café Marée Charters",
      "Fish & Dive Co.",
      "Harbor Support",
      "Via Ferrata Adventures",
      "Riptide Grill",
      "No Wake Charters",
      "St. Augustine Kayaks",
      "Captain Ann's Boats (Key West)",
      "Your trip operator",
    ]) {
      expect(senderNameProblem(name), name).toBeNull();
    }
    expect(accepts({})).toBe(true);
  });

  it.each([
    // TideGrid itself and its staff.
    ["TideGrid", "TideGrid"],
    ["lowercase", "tidegrid"],
    ["staff", "TideGrid Support"],
    ["spaced", "Tide Grid"],
    ["hyphenated", "Tide-Grid Billing"],
    ["inside a longer name", "Harbor TideGrid Desk"],
    // Lookalike spellings.
    ["digits for letters", "T1deGr1d"],
    ["a capital I for l", "TIdeGrId"],
    ["symbols for letters", "T!de Gr!d"],
    ["cl for d", "TideGricl"],
    ["accents", "Tídé Gríd"],
    ["Latin dotless i", "TıdeGrıd"],
    ["Latin small capitals", "ᴛɪᴅᴇɢʀɪᴅ"],
    // Unicode confusables from other scripts and compatibility forms.
    ["Cyrillic i", "TіdeGrіd"],
    ["Cyrillic T and e", "ТidеGrid"],
    ["Greek omicron", "Harbοr"],
    ["fullwidth letters", "ＴｉｄｅＧｒｉｄ"],
    ["a decomposed accent", "Café Charters"],
    // Cf format characters.
    ["a zero-width space", "Tide​Grid"],
    ["a zero-width joiner", "Harbor‍Charters"],
    ["a right-to-left override", "Harbor‮Charters"],
    ["a byte order mark", "﻿Harbor"],
    ["a soft hyphen", "Tide­Grid"],
    // CR and LF header injection, and other controls.
    ["CR LF", "Harbor\r\nBcc: victim@example.test"],
    ["LF", "Harbor\nX-Inj: 1"],
    ["CR", "Harbor\rX-Inj: 1"],
    ["a tab", "Harbor\tCharters"],
    ["NEL", "Harbor\u0085Charters"],
    ["a line separator", "Harbor Charters"],
    ["a no-break space", "Harbor Charters"],
    // Reserved names.
    ["Support", "Support"],
    ["Customer Support", "Customer Support"],
    ["Billing Team", "Billing Team"],
    ["No-Reply", "No-Reply"],
    ["NoReply", "NoReply"],
    ["Postmaster", "Postmaster"],
    ["The Security Team", "The Security Team"],
    ["Help Desk", "Help Desk"],
    // Names that read as an address or a second relay.
    ["an address", "ops@example.test"],
    ["a domain", "paypal.com"],
    ["a second relay", "Harbor via Stripe"],
    ["a quote", 'Harbor "Official"'],
    ["a colon", "Harbor: Bookings"],
    ["a semicolon", "Harbor; Bookings"],
    ["angle brackets", "Harbor <ops@example.test>"],
    ["a backslash", "Harbor\\Charters"],
    // Shape.
    ["empty", ""],
    ["padding", " Harbor"],
    ["double spaces", "Harbor  Charters"],
    ["no letter", "1234"],
    ["too long", "A".repeat(81)],
  ])("refuses %s", (_label, name) => {
    expect(senderNameProblem(name)).not.toBeNull();
    expect(senderDisplayName(name)).toBeNull();
  });

  it("is applied in brand validation: the name and the reply-to contact", () => {
    for (const name of ["TideGrid Support", "TіdeGrіd", "Customer Support", "Harbor via Stripe"]) {
      expect(accepts({ name }), name).toBe(false);
    }
    for (const email of [
      "support@tidegrid.us",
      "hello@mail.tidegrid.com",
      "hello@t1degrid.example",
    ]) {
      expect(accepts({ contact: { email } }), email).toBe(false);
      expect(contactEmailProblem(email)).not.toBeNull();
    }
    expect(contactEmailProblem("hello@demo-harbor.test")).toBeNull();
  });

  it("folds names to one skeleton", () => {
    expect(senderSkeleton("T1de Gr!d")).toBe("tidegrid");
    expect(senderSkeleton("ТіdеGrid")).toBe("tidegrid");
    expect(senderSkeleton("TideGricl")).toBe("tidegrid");
    expect(sameSenderName("Demo Harbor Charters", "DEMO HARBOR CHARTERS")).toBe(true);
    expect(sameSenderName("Demo Harbor Charters", "Demo Reef Divers")).toBe(false);
    expect(sameSenderName("", "")).toBe(false);
  });

  it.each([
    // Review S1: Latin letters the skeleton cannot fold count for nothing, so
    // they are refused rather than dropped.
    ["unfolded lookalikes only", "ƬɨɖɇƓɍɨɖ"],
    ["i with stroke", "TɨdeGrɨd"],
    ["i with stroke and a staff word", "Tɨdegrɨd Support"],
    ["d with tail", "TideGriɖ Billing"],
    ["a dental click", "TǀdeGrǀd"],
    ["unfolded lookalikes and staff words", "Ƭɨɖɇ Ɠɍɨɖ Billing Team"],
    ["an open e", "Harbɛr"],
    ["an unmapped small capital", "Hᴀrbor"],
    // Review R1 and S2: digits, single letters, and filler do not rescue a
    // name that is otherwise only staff or mailbox words.
    ["a digit after staff words", "Support Team 2"],
    ["a digit that reads as a letter", "Security Team 1"],
    ["a country code", "Billing (US)"],
    ["do not reply", "Do Not Reply"],
    ["a department", "Billing Dept"],
    ["a department, spelled out", "Payment Department"],
    ["a help center", "Help Center"],
    ["accounts payable", "Accounts Payable"],
    ["a general postmaster", "Postmaster General"],
  ])("refuses %s (review fixes)", (_label, name) => {
    expect(senderNameProblem(name)).not.toBeNull();
    expect(senderDisplayName(name)).toBeNull();
    expect(accepts({ name })).toBe(false);
  });

  // Recheck N1: Latin Roman numerals with no NFKC decomposition. They are
  // number letters (Nl), not letters, so the letter fold never saw them.
  it.each([
    ["U+2180", "ↀ"],
    ["U+2181", "ↁ"],
    ["U+2182", "ↂ"],
    ["U+2185", "ↅ"],
    ["U+2186", "ↆ"],
    ["U+2187", "ↇ"],
    ["U+2188", "ↈ"],
  ])("refuses the Roman numeral %s (recheck N1)", (_label, numeral) => {
    expect(numeral.normalize("NFKC")).toBe(numeral);
    for (const name of [`TideGri${numeral}`, `Harbor ${numeral} Tours`, `Harbor Tours${numeral}`]) {
      expect(senderNameProblem(name), name).not.toBeNull();
      expect(senderDisplayName(name), name).toBeNull();
      expect(accepts({ name }), name).toBe(false);
    }
    expect(sameSenderName(`Demo Harbor Charters${numeral}`, "Demo Harbor Charters")).toBe(false);
  });

  // Recheck N2: words are split after folding, and a run of short words can
  // spell "via" across separators.
  it.each([
    ["an exclamation mark for i", "Harbor v!a Stripe"],
    ["dots between letters", "Harbor v.i.a Stripe"],
    ["hyphens between letters", "Harbor V-I-A Stripe"],
    ["spaces between letters", "Harbor V I A Stripe"],
    ["a split word", "Harbor Vi A Stripe"],
    ["a digit and dots", "Harbor V.1.A Stripe"],
    ["an accent and a separator", "Harbor V.Í.A Stripe"],
    ["an exclamation mark inside a staff word", "B!lling Team"],
  ])("refuses %s (recheck N2)", (_label, name) => {
    expect(senderNameProblem(name)).not.toBeNull();
    expect(senderDisplayName(name)).toBeNull();
    expect(accepts({ name })).toBe(false);
  });

  // Recheck R1: "!" folds to "i", so the folded split read "Support!" as
  // "supporti" and "via!" as "viai". Each check now runs on the folded split,
  // the folded split with such symbols trimmed, and the plain split.
  it.each([
    "Support!",
    "Billing!",
    "Security!",
    "Help!",
    "Support!!",
    "!Billing",
    "Support! Team!",
    "Security Team!",
    "The Security Team!",
    "Customer Support!",
    "Do Not Reply!",
    "Billing Dept!",
    "Help Center!",
    "Payments Team!",
    "No!Reply",
    "Support!Team",
    "Harbor via! Stripe",
    "Harbor !via Stripe",
    "Harbor via!Stripe",
    "Harbor V!A!",
  ])("refuses %s with an exclamation mark at a word's edge (recheck R1)", (name) => {
    expect(senderNameProblem(name), name).not.toBeNull();
    expect(senderDisplayName(name), name).toBeNull();
    expect(accepts({ name }), name).toBe(false);
  });

  // Recheck F2: a digit such as "1" folds to a letter, so "Support1" read as
  // "supporti" in every split that keeps digits. The letters-only split reads
  // it as "Support".
  it.each([
    "Support1",
    "Security1",
    "Billing1",
    "Help0",
    "NoReply1",
    "Payments4",
    "Support7",
    "Support24",
    "Support1!",
    "24 Support",
    "Harbor via1 Stripe",
    "Harbor 1via Stripe",
  ])("refuses %s with a digit glued to a staff word or via (recheck F2)", (name) => {
    expect(senderNameProblem(name), name).not.toBeNull();
    expect(senderDisplayName(name), name).toBeNull();
    expect(accepts({ name }), name).toBe(false);
  });

  it("still accepts operator names with digits (recheck F2)", () => {
    for (const name of [
      "Harbor Tours 24",
      "Dive 4 Fun",
      "Boats4Support Harbor",
      "Pier 39 Charters",
    ]) {
      expect(senderNameProblem(name), name).toBeNull();
    }
  });

  it("still accepts operator names with an exclamation mark (recheck R1)", () => {
    for (const name of ["Harbor Tours!", "Dive In! Charters", "Yahoo! Boats", "Support Boats!"]) {
      expect(senderNameProblem(name), name).toBeNull();
    }
  });

  it("still accepts via as a first word or inside a longer word (recheck N2)", () => {
    for (const name of [
      "Via Ferrata Adventures",
      "V!a Ferrata Tours",
      "V.I.A. Harbor Tours",
      "Vivian Charters",
      "Harbor Avian Tours",
      "Harbor Trivia Cruises",
      "Supp!rt Boats",
    ]) {
      expect(senderNameProblem(name), name).toBeNull();
    }
  });

  it("binds only to the same letters and digits: appended unfolded text does not bind", () => {
    for (const name of [
      "ƬɨɖɇƓɍɨɖ ꜱᴜᴘᴘꝋɍƭ (Demo Harbor Charters)",
      "Demo Harbor Charters ǀ Ʈɨɖɛ Ǥɽɨɖ",
      "Ɨɖ ɛʋɛɽɨ Demo Harbor Charters",
      "Demo Harbor Charters 2",
      "Demo Harbor Charters 26",
    ]) {
      expect(sameSenderName(name, "Demo Harbor Charters"), name).toBe(false);
    }
    expect(sameSenderName("Demo Harbor Charters!", "Demo Harbor Charters")).toBe(false);
    expect(sameSenderName("Demo Harbor-Charters", "Demo Harbor Charters")).toBe(true);
    expect(sameSenderName("Démo Harbor Charters", "Demo Harbor Charters")).toBe(true);
  });

  it("keeps a TideGrid name out of the contact local part (review S3)", () => {
    for (const email of ["tidegrid.support@demo-harbor.test", "tidegrid-support@gmail.com"]) {
      expect(contactEmailProblem(email), email).not.toBeNull();
      expect(accepts({ contact: { email } }), email).toBe(false);
    }
  });

  it("still accepts operator names with filler and digits beside an operator word", () => {
    for (const name of [
      "Harbor Office 2",
      "Do Dive Center",
      "Key West Help Center Kayaks",
      "Ølfjord Tours",
      "Straße Boats",
    ]) {
      expect(senderNameProblem(name), name).toBeNull();
    }
  });

  it("takes a name that already carries the suffix without doubling it", () => {
    expect(senderDisplayName("Demo Reef Divers via TideGrid")).toBe(
      "Demo Reef Divers via TideGrid",
    );
    expect(senderDisplayName("TideGrid via TideGrid")).toBeNull();
  });
});
