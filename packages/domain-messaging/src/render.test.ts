import { describe, expect, it } from "vitest";
import {
  checkContent,
  type EmailBrand,
  type EmailContent,
  escapeHtml,
  fillLinkSlot,
  linkMarker,
  renderEmail,
} from "./render.ts";

const brand: EmailBrand = {
  name: "Demo Harbor <Charters> & Co",
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
    expect(out.html).toContain("Demo Harbor &lt;Charters&gt; &amp; Co");
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
    expect(out.text.startsWith("Demo Harbor <Charters> & Co\n")).toBe(true);
    expect(out.text).toContain("Trip: Sunset <sail>");
    expect(out.text).toContain("Total: $96.30");
    expect(out.text).toContain("no real booking or payment is made");
    expect(out.html).toContain('lang="en"');
  });

  it("picks a readable text color on the operator's primary", () => {
    const light = renderEmail({ ...brand, primary: "#e0a526" }, content, { slot });
    expect(light.html).toContain('color:#0e2b1f;">Demo Harbor');
    const dark = renderEmail(brand, content, { slot });
    expect(dark.html).toContain('color:#ffffff;">Demo Harbor');
  });
});
