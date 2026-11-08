import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkContent,
  displayPhone,
  type EmailBrand,
  type EmailContent,
  emailOperatorName,
  emailSenderName,
  escapeHtml,
  fillLinkSlot,
  linkMarker,
  renderEmail,
} from "./render.ts";

const brand: EmailBrand = {
  name: "Demo Harbor's Charters & Co",
  primary: "#0b3c5d",
  accent: "#e0a526",
  contactEmail: "hello@demo-harbor.test",
  contactPhone: "+13055550142",
};

const slot = "0123456789abcdef0123456789abcdef";
const token = "A".repeat(43);

const content: EmailContent = {
  subject: "Booking 7KQ2M9XA is confirmed",
  preview: "See you on the water",
  blocks: [
    { kind: "heading", text: "You're booked, <script>alert(1)</script>" },
    { kind: "paragraph", text: 'Booker "Ann" & friends' },
    { kind: "details", rows: [{ label: "Trip", value: "Sunset <sail>" }] },
    {
      kind: "lines",
      rows: [
        { label: "Adult x 2", amount: "$90.00" },
        { label: "Total", amount: "$96.30", strong: true },
      ],
    },
    { kind: "action", label: "Manage your booking", href: "access_link" },
    { kind: "note", text: "This link works once." },
  ],
};

describe("email rendering", () => {
  it("escapes every text, including the brand name", () => {
    const out = renderEmail(brand, content, { slot });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.html).toContain("Demo Harbor&#39;s Charters &amp; Co");
    expect(out.html).toContain("Booker &quot;Ann&quot; &amp; friends");
    expect(out.html).toContain("Sunset &lt;sail&gt;");
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("puts the link's marker where the URL goes, and never a token", () => {
    const out = renderEmail(brand, content, { slot });
    const marker = linkMarker(slot);
    // The button's href, and the fallback address as a link and as its text.
    expect(out.html.split(marker).length - 1).toBe(3);
    expect(out.text.split(marker).length - 1).toBe(1);
    const url = `http://demo-harbor.book.localhost:5301/manage#t=${token}`;
    const html = fillLinkSlot(out.html, slot, url);
    const text = fillLinkSlot(out.text, slot, url);
    expect(html).not.toContain(marker);
    expect(html).toContain(`href="${url}"`);
    expect(text).toContain(url);
  });

  it("refuses an access-link action without a slot, and a URL that is not a link", () => {
    expect(() => renderEmail(brand, content)).toThrow(TypeError);
    const out = renderEmail(brand, content, { slot });
    expect(() => fillLinkSlot(out.html, slot, "javascript:alert(1)")).toThrow(TypeError);
    expect(() => fillLinkSlot(out.html, slot, `https://x.test/manage#t=${token}"onload=1`)).toThrow(
      TypeError,
    );
  });

  it("checks content: one subject line, one action, https links, no control characters", () => {
    expect(() => checkContent({ ...content, subject: "Two\nlines" })).toThrow(TypeError);
    // A tab passed here once, and the database refused it inside the confirming transaction.
    expect(() => checkContent({ ...content, subject: "Sunset\tCruise" })).toThrow(TypeError);
    expect(() => checkContent({ ...content, preview: "See you\nsoon" })).toThrow(TypeError);
    expect(() => checkContent({ ...content, preview: "See you\tsoon" })).toThrow(TypeError);
    expect(() =>
      checkContent({
        subject: "x",
        blocks: [
          { kind: "action", label: "a", href: "https://a.test/" },
          { kind: "action", label: "b", href: "https://b.test/" },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      checkContent({
        subject: "x",
        blocks: [{ kind: "action", label: "a", href: "http://a.test/" as `https://${string}` }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      checkContent({ subject: "x", blocks: [{ kind: "paragraph", text: "bell\u0007" }] }),
    ).toThrow(TypeError);
    expect(() => checkContent({ subject: "x", blocks: [] })).toThrow(TypeError);
  });

  it("writes a plain-text twin with the footer and the demo notice", () => {
    const out = renderEmail(brand, content, { slot });
    expect(out.text.startsWith("Demo Harbor's Charters & Co\n")).toBe(true);
    expect(out.text).toContain("Trip: Sunset <sail>");
    expect(out.text).toContain("Total: $96.30");
    expect(out.text).toContain("no real booking or payment is made");
    expect(out.html).toContain('lang="en"');
  });

  it("shows the operator's phone as the booking site does", () => {
    const out = renderEmail(brand, content, { slot });
    expect(out.text).toContain("hello@demo-harbor.test, (305) 555-0142.");
    expect(out.html).toContain("(305) 555-0142");
    expect(out.html).not.toContain("+13055550142");
    expect(displayPhone("+13055550142")).toBe("(305) 555-0142");
    expect(displayPhone("+442079460000")).toBe("+442079460000");
  });

  it("picks a readable text color on the operator's primary", () => {
    const light = renderEmail({ ...brand, primary: "#e0a526" }, content, { slot });
    expect(light.html).toContain('color:#0e2b1f;">Demo Harbor');
    const dark = renderEmail(brand, content, { slot });
    expect(dark.html).toContain('color:#ffffff;">Demo Harbor');
  });
});

describe("sender identity (W1-SENDER-GUARD)", () => {
  const harbor: EmailBrand = {
    name: "Demo Harbor Charters",
    primary: "#0b3c5d",
    accent: "#e0a526",
    contactEmail: "hello@demo-harbor.test",
    contactPhone: "+13055550142",
  };
  const reef: EmailBrand = {
    name: "Demo Reef Divers",
    primary: "#006d77",
    accent: "#ffd166",
    contactEmail: "dive@demo-reef.test",
    contactPhone: "+13055550187",
  };
  // Every block kind, as the templates use them.
  const golden: EmailContent = {
    subject: "Booking 7KQ2M9XA is confirmed",
    preview: "See you on the water",
    blocks: [
      { kind: "heading", text: "You're booked" },
      { kind: "paragraph", text: 'Booker "Ann" & friends' },
      {
        kind: "details",
        rows: [
          { label: "Trip", value: "Sunset sail" },
          { label: "Meet", value: "Dock C" },
        ],
      },
      {
        kind: "lines",
        rows: [
          { label: "Adult x 2", amount: "$90.00" },
          { label: "Total", amount: "$96.30", strong: true },
        ],
      },
      { kind: "action", label: "Manage your booking", href: "access_link" },
      { kind: "note", text: "This link works once." },
    ],
  };
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  it("renders the two synthetic brands exactly as before the guard", () => {
    // Hashes of the baseline renderer's output (b1461f3) for the same input.
    const before = [
      [
        harbor,
        "27ba75520d4a0ccfb56181f4da2c70ffb3b01b95a90bfb23e41b7fe7d9ccb4ae",
        "3e0cc92e921144c25931dd171d2b3466a270cfd1a0961f78f271719494d08e69",
      ],
      [
        reef,
        "f9a327d64f96245cd841e26549db07c01a77df89f6d4ce9aedacd9abd3a0fa3b",
        "5ed4882c766eb83bdb85a4c0609bc8172752e6b59a926d47333fac01114f7a02",
      ],
    ] as const;
    for (const [b, html, text] of before) {
      const out = renderEmail(b, golden, { slot });
      expect(sha(out.html), b.name).toBe(html);
      expect(sha(out.text), b.name).toBe(text);
      expect(out.subject).toBe(golden.subject);
    }
  });

  it("sends as the operator's name via TideGrid", () => {
    expect(renderEmail(harbor, golden, { slot }).fromName).toBe(
      "Demo Harbor Charters via TideGrid",
    );
    expect(renderEmail(reef, golden, { slot }).fromName).toBe("Demo Reef Divers via TideGrid");
    expect(emailSenderName(reef)).toBe("Demo Reef Divers via TideGrid");
  });

  it.each([
    ["TideGrid itself", "TideGrid"],
    ["TideGrid staff", "TideGrid Support"],
    ["a lookalike spelling", "T1de Gr!d"],
    ["Cyrillic i (a Unicode confusable)", "T\u0456deGr\u0456d"],
    ["fullwidth letters", "\uff34\uff49\uff44\uff45\uff27\uff52\uff49\uff44"],
    ["Latin small capitals", "\u1d1b\u026a\u1d05\u1d07\u0262\u0280\u026a\u1d05"],
    ["a reserved staff name", "Customer Support"],
    ["a mailbox name", "No-Reply"],
    ["a second relay", "Harbor via Stripe"],
    ["a domain", "billing.example"],
    ["a right-to-left override (Cf)", "Harbor\u202eCharters"],
    ["a zero-width space (Cf)", "Tide\u200bGrid"],
    ["CR and LF header injection", "Harbor\r\nBcc: victim@example.test"],
    ["a bare LF", "Harbor\nX-Inj: 1"],
    ["angle brackets", "Harbor <ops@example.test>"],
    // Review S1: Latin letters that do not fold to a to z.
    ["unfolded lookalikes", "\u01ac\u0268\u0256\u0247\u0193\u024d\u0268\u0256"],
    ["i with stroke", "T\u0268deGr\u0268d"],
    [
      "unfolded lookalikes and staff words",
      "\u01ac\u0268\u0256\u0247 \u0193\u024d\u0268\u0256 Billing Team",
    ],
    [
      "unfolded text around an operator name",
      "\u01ac\u0268\u0256\u0247\u0193\u024d\u0268\u0256 (Demo Harbor Charters)",
    ],
    // Review R1 and S2: staff names with a digit or filler word.
    ["do not reply", "Do Not Reply"],
    ["staff words and a digit", "Support Team 2"],
    ["staff words and a digit that reads as a letter", "Security Team 1"],
    ["staff words and a country code", "Billing (US)"],
    ["a department", "Billing Dept"],
  ])("never shows or sends %s as the operator", (_label, name) => {
    const out = renderEmail({ ...harbor, name }, golden, { slot });
    expect(emailOperatorName({ name })).toBe("Your trip operator");
    expect(out.fromName).toBe("Your trip operator via TideGrid");
    expect(out.text.startsWith("Your trip operator\n")).toBe(true);
    expect(out.text).toContain("Sent by TideGrid for Your trip operator.");
    expect(out.html).toContain(">Your trip operator</td>");
    expect(out.html).not.toContain("\r");
  });
});
