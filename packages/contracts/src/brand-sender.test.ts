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
  // "supporti" and "via!" as "viai". A "!" may also be read as a separator.
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
  // "supporti" in every split that keeps digits. A digit may also be read as a
  // separator, which reads it as "Support".
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

  // Pull request review fix: fixed readings never read a "!" and a digit with
  // different meanings together. Each digit or "!" may now read as its letter,
  // stay a digit, or separate, and a name is refused if any reading fires.
  it.each([
    "B!lling1",
    "B!lling!Team",
    "Harbor v!a1 Stripe",
    "Harbor V!A!Stripe",
    "1B!lling",
    "Supp0rt!Team",
    "N0!Reply1",
    "Harbor 4v!a Stripe",
  ])("refuses %s, with mixed readings of digits and symbols (pull request review)", (name) => {
    expect(senderNameProblem(name), name).not.toBeNull();
    expect(senderDisplayName(name), name).toBeNull();
    expect(accepts({ name }), name).toBe(false);
  });

  // Recheck of the pull request fix: a first word made only of digits that
  // fold to no letter ("2", "6") is still a first word.
  it.each([
    "2 via Stripe",
    "26 via PayPal",
    "6-Via Square",
    "(2) Via Stripe",
    "#26 via Stripe",
    "2 V I A Stripe",
    "22 Via Venmo",
  ])("refuses %s, a relay after a digit-only first word", (name) => {
    expect(senderNameProblem(name), name).not.toBeNull();
    expect(senderDisplayName(name), name).toBeNull();
    expect(accepts({ name }), name).toBe(false);
  });

  it("lists every punctuation mark the character rule allows in its message", () => {
    const problem = senderNameProblem("Harbor @ Tours");
    expect(problem).not.toBeNull();
    for (const mark of ["&", "'", "’", ".", ",", "!", "(", ")", "/", "+", "#", "-"]) {
      expect(problem, mark).toContain(` ${mark}`);
      expect(senderNameProblem(`Harbor ${mark}Tours`), mark).not.toBe(problem);
    }
  });

  it("never binds a brand to a provisioned name the rule refuses (pull request review)", () => {
    expect(senderNameProblem("Billing1")).not.toBeNull();
    expect(sameSenderName("B!lling1", "Billing1")).toBe(false);
    expect(sameSenderName("Billing1", "Billing1")).toBe(false);
    expect(sameSenderName("BillingTeam", "Billing Team")).toBe(false);
    expect(sameSenderName("Pier 39 Charters", "PIER 39 CHARTERS")).toBe(true);
  });

  it("refuses staff words and via under every placement of a digit or symbol (pull request review)", () => {
    const ambiguous = ["!", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const refused: string[] = [];
    for (const d of ambiguous) {
      for (const word of ["Support", "Billing", "NoReply", "Help", "Security"]) {
        refused.push(`${word}${d}`, `${d}${word}`, `${word}${d}Team`, `${d}${word}${d}`);
      }
      refused.push(`Harbor via${d}Stripe`, `Harbor ${d}via Stripe`, `Harbor via${d}`);
      for (const i of ["!", "1"]) {
        refused.push(`Harbor v${i}a${d}Stripe`, `B${i}lling${d}`, `B${i}lling${d}Team`);
      }
    }
    for (const name of refused) {
      expect(senderNameProblem(name), name).not.toBeNull();
    }
  });

  it("caps the digits and exclamation marks in a name (pull request review)", () => {
    expect(senderNameProblem("Harbor 1987 Tours 305 55501")).toBeNull();
    expect(senderNameProblem("Harbor 1987 Tours 305 555012")).not.toBeNull();
    expect(senderNameProblem(`Harbor${"!".repeat(12)} Tours`)).toBeNull();
    expect(senderNameProblem(`Harbor${"!".repeat(13)} Tours`)).not.toBeNull();
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

  // Pull request review fix G2: the reserved-name check reads each digit or
  // "!" as its letter or as nothing, as the staff and relay checks do.
  it.each([
    "Tide!Grid",
    "T!de!Gr!d",
    "T1deGr1d",
    "Tide-Grid",
    "T!de Gr!d",
    "Tide1Grid",
    "Tide!Gr!d Tours",
    "Harbor T!de 2 Gr!d",
  ])("refuses %s, TideGrid under some reading of its digits and symbols (G2)", (name) => {
    expect(senderNameProblem(name), name).toBe(
      "A sender name may not use or imitate the TideGrid name",
    );
    expect(senderDisplayName(name), name).toBeNull();
    expect(accepts({ name }), name).toBe(false);
  });

  it("refuses a name exactly when some reading of its digits and symbols contains TideGrid (G2 oracle)", () => {
    // The oracle lists every reading: each digit or "!" is kept, so the
    // skeleton reads it as its letter, or replaced by a space, so it drops.
    const reads = (name: string): boolean => {
      const at = [...name].flatMap((ch, i) => (/[0-9!]/.test(ch) ? [i] : []));
      for (let pick = 0; pick < 1 << at.length; pick += 1) {
        const chars = [...name];
        at.forEach((i, bit) => {
          if (pick & (1 << bit)) chars[i] = " ";
        });
        if (senderSkeleton(chars.join("")).includes("tidegrid")) return true;
      }
      return false;
    };
    const alphabet = [..."tidegrclnvmwTG!1023-"];
    let seed = 20261108;
    const random = (n: number) => {
      // Exact 32-bit arithmetic: a plain multiply passes 2^53 and rounds,
      // which repeats names and starves the "!" cases.
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 16) % n;
    };
    // Half the names mutate TideGrid: a letter may become a lookalike, and
    // any character may be inserted between two.
    const variants: Record<string, string[]> = {
      T: ["T", "t", "7"],
      i: ["i", "!", "1", "l"],
      d: ["d", "cl"],
      e: ["e", "3"],
      G: ["G", "g", "9"],
      r: ["r"],
    };
    const mutated = () => {
      let name = "";
      for (const ch of "TideGrid") {
        const options = variants[ch] ?? [ch];
        name += options[random(options.length)];
        if (random(3) === 0) name += alphabet[random(alphabet.length)];
      }
      return name;
    };
    let refused = 0;
    const names = new Set<string>();
    let withBang = 0;
    for (let round = 0; round < 6000; round += 1) {
      let name = "H";
      if (round % 2 === 0) name += mutated();
      else {
        const length = 6 + random(9);
        for (let i = 0; i < length; i += 1) name += alphabet[random(alphabet.length)];
      }
      names.add(name);
      if (name.includes("!")) withBang += 1;
      const expected = reads(name);
      if (expected) refused += 1;
      const problem = senderNameProblem(name);
      expect(problem === "A sender name may not use or imitate the TideGrid name", name).toBe(
        expected,
      );
      const local = name.toLowerCase().replaceAll("!", "");
      expect(contactEmailProblem(`${local}@harbor.test`) !== null, local).toBe(reads(local));
    }
    // The sample is varied: mostly distinct names, many with a "!".
    expect(names.size).toBeGreaterThan(5000);
    expect(withBang).toBeGreaterThan(1000);
    // The sample exercises the refusal, not only the pass.
    expect(refused).toBeGreaterThan(300);
    expect(refused).toBeLessThan(5500);
  });

  it("reads digits in a contact address as letters or as nothing (G2)", () => {
    for (const email of [
      "tide1grid@harbor.test",
      "hello@tide2grid.test",
      "t1de.gr1d@harbor.test",
    ]) {
      expect(contactEmailProblem(email), email).not.toBeNull();
      expect(accepts({ contact: { email } }), email).toBe(false);
    }
    expect(contactEmailProblem("hello@demo-harbor.test")).toBeNull();
    expect(contactEmailProblem("captain1987@riptide-grill.test")).toBeNull();
  });

  it("refuses an internationalized (xn--) contact domain (G3)", () => {
    for (const email of [
      "support@xn--tdegrd-pvfe.test",
      "hello@XN--tdegrd-pvfe.test",
      "hello@mail.xn--tdegrd-pvfe.test",
    ]) {
      expect(contactEmailProblem(email), email).toBe(
        "A contact address may not use an internationalized (xn--) domain",
      );
      expect(accepts({ contact: { email } }), email).toBe(false);
    }
    // Only a label that starts with xn-- is IDNA.
    expect(contactEmailProblem("xn--hello@harbor.test")).toBeNull();
    expect(contactEmailProblem("hello@harbor-xn--.test")).toBeNull();
  });

  it("takes a name that already carries the suffix without doubling it", () => {
    expect(senderDisplayName("Demo Reef Divers via TideGrid")).toBe(
      "Demo Reef Divers via TideGrid",
    );
    expect(senderDisplayName("TideGrid via TideGrid")).toBeNull();
  });
});
