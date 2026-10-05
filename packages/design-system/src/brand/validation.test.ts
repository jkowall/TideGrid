import { describe, expect, it } from "vitest";
import {
  BrandConfig,
  isHttpsUrl,
  logoProblem,
  maxLogoBytes,
  PublicBrand,
  PublicExperienceResponse,
  PublicTenantIdentity,
  svgLogoProblem,
} from "./index.ts";

const svgUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const bytesUri = (type: string, bytes: number[] | Buffer) =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const wrap = (inner: string, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

const logoSvg =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 48" width="200" height="48" role="img" aria-label="Demo">' +
  "<title>Demo &amp; Co</title>" +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b3c5d"/><stop offset="1" stop-color="#e0a526"/></linearGradient>' +
  '<linearGradient id="g2" xlink:href="#g" gradientTransform="rotate(90)"/><radialGradient id="g3" href="#g"/>' +
  '<clipPath id="c"><circle cx="20" cy="20" r="18"/></clipPath>' +
  '<mask id="m"><rect width="200" height="48" fill="url(#g2)"/></mask></defs>' +
  '<g transform="translate(4 4) scale(1)"><path d="M0 0h40v40H0z" fill="url(#g)" clip-path="url(#c)"/><rect x="44" width="10" height="10" fill="url(#g3)" mask="url(#m)"/></g>' +
  '<text x="64" y="30" font-family="Georgia, serif" font-size="20" fill="#0b3c5d">Demo <tspan font-weight="700">Harbor</tspan></text>' +
  "</svg>";

const base = {
  name: "Demo Harbor Charters",
  tagline: "Half-day and sunset trips from a synthetic marina",
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  logo: {
    src: svgUri(logoSvg),
    kind: "lockup",
    alt: "Demo Harbor Charters",
    width: 200,
    height: 48,
  },
  contact: { email: "hello@demo-harbor.test", phone: "+13055550142" },
  legal: { terms: "/legal/terms", privacy: "https://demo-harbor.test/privacy" },
  locale: "en-US",
  capabilities: [],
};

type Patch = Record<string, unknown>;
const withPatch = (patch: Patch) => ({ ...base, ...patch });
const messages = (input: unknown) => {
  const parsed = BrandConfig.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("brand validation", () => {
  it("accepts a complete, well-formed brand", () => {
    expect(messages(base)).toEqual([]);
    const { logo: _logo, tagline: _tagline, ...minimal } = base;
    expect(messages({ ...minimal, contact: { phone: "+13055550142" } })).toEqual([]);
  });

  it("rejects colors that are not six-digit lowercase hex", () => {
    for (const primary of ["#0B3C5D", "#036", "0b3c5d", "navy", "#0b3c5dff", "rgb(11,60,93)"]) {
      expect(messages(withPatch({ colors: { primary, accent: "#e0a526" } }))).not.toEqual([]);
    }
  });

  it("rejects a primary too light for the page and an accent too close to the primary", () => {
    expect(messages(withPatch({ colors: { primary: "#7fb3d5", accent: "#0b3c5d" } }))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^colors: Primary #7fb3d5 has .* it needs 4.5:1/),
      ]),
    );
    expect(messages(withPatch({ colors: { primary: "#0b3c5d", accent: "#2a5a7a" } }))).toEqual([
      expect.stringMatching(/^colors: Accent #2a5a7a has .* it needs 3:1$/),
    ]);
  });

  it("rejects fonts outside the supported set, including the wrong role", () => {
    const fonts = [
      { display: "comic-sans", body: "inter" },
      { display: "inter", body: "inter" },
      { display: "sora", body: "sora" },
      { display: "Sora", body: "inter" },
      { display: "sora", body: "https://fonts.example/x.woff2" },
    ];
    for (const f of fonts) expect(messages(withPatch({ fonts: f }))).not.toEqual([]);
  });

  it("rejects markup and control characters in copy", () => {
    const names = [
      "<script>alert(1)</script>",
      "Harbor <b>",
      "Harbor\u0000",
      "Line\nbreak",
      " Harbor",
      "",
    ];
    for (const name of names) expect(messages(withPatch({ name }))).not.toEqual([]);
    expect(messages(withPatch({ tagline: "x".repeat(141) }))).not.toEqual([]);
    expect(messages(withPatch({ name: "Fish & Dive Co." }))).toEqual([]);
  });

  it.each([
    ["next line U+0085", "\u0085"],
    ["right-to-left override U+202E", "‮"],
    ["line separator U+2028", " "],
    ["zero-width space U+200B", "​"],
    ["byte order mark U+FEFF", "﻿"],
    ["a lone surrogate U+D800", "\uD800"],
  ])("rejects %s in the name, tagline, and logo text", (_label, ch) => {
    expect(messages(withPatch({ name: `Harbor${ch}Charters` }))).not.toEqual([]);
    expect(messages(withPatch({ tagline: `Sunset${ch}sails` }))).not.toEqual([]);
    expect(messages(withPatch({ logo: { ...base.logo, alt: `Harbor${ch}` } }))).not.toEqual([]);
    expect(isHttpsUrl(`https://demo-harbor.test/te${ch}rms`)).toBe(false);
  });

  it("keeps ordinary accented and punctuated copy", () => {
    expect(
      messages(withPatch({ name: "Café Marée Charters", tagline: "Dawn to dusk, 7 days" })),
    ).toEqual([]);
  });

  it("rejects unknown fields anywhere, so no style or markup can ride along", () => {
    expect(messages(withPatch({ css: "body{display:none}" }))).not.toEqual([]);
    expect(messages(withPatch({ colors: { ...base.colors, background: "#000000" } }))).not.toEqual(
      [],
    );
    expect(messages(withPatch({ logo: { ...base.logo, style: "x" } }))).not.toEqual([]);
    expect(messages(withPatch({ html: "<p>hi</p>" }))).not.toEqual([]);
  });

  it("rejects links that are not https or a path on this site", () => {
    const bad = [
      "http://demo-harbor.test/terms",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "//evil.test/terms",
      "/\\evil.test/terms",
      "https://user:secret@demo-harbor.test/terms",
      "https://10.0.0.1/terms",
      "https://demo-harbor.test:8443/terms",
      "https://demo-harbor.test/te rms",
      "terms",
      "https:/demo-harbor.test",
      "HTTPS://demo-harbor.test/terms\n",
    ];
    for (const terms of bad) {
      expect({
        terms,
        ok: messages(withPatch({ legal: { ...base.legal, terms } })).length === 0,
      }).toEqual({ terms, ok: false });
    }
    for (const terms of [
      "/legal/terms",
      "/legal/terms#cancellation",
      "https://demo-harbor.test/t?x=1",
    ]) {
      expect(messages(withPatch({ legal: { ...base.legal, terms } }))).toEqual([]);
    }
    expect(isHttpsUrl("https://demo-harbor.test")).toBe(true);
    expect(
      messages(withPatch({ contact: { ...base.contact, website: "http://x.test" } })),
    ).not.toEqual([]);
  });

  it("requires a way to reach the operator and well-formed contact details", () => {
    expect(messages(withPatch({ contact: {} }))).not.toEqual([]);
    expect(messages(withPatch({ contact: { phone: "305-555-0142" } }))).not.toEqual([]);
    expect(messages(withPatch({ contact: { email: "hKelvin@demo.test" } }))).not.toEqual([]);
  });

  it("accepts only the listed locale and capabilities, once each", () => {
    expect(messages(withPatch({ locale: "fr-FR" }))).not.toEqual([]);
    expect(messages(withPatch({ capabilities: ["tips", "tips"] }))).not.toEqual([]);
    expect(messages(withPatch({ capabilities: ["loyalty_points"] }))).not.toEqual([]);
    expect(messages(withPatch({ capabilities: ["tips", "trip_cards"] }))).toEqual([]);
  });
});

describe("logo validation", () => {
  it("accepts inert shapes, gradients, clipping, masks, local references, and text", () => {
    expect(svgLogoProblem(logoSvg)).toBeNull();
    expect(logoProblem(svgUri(logoSvg))).toBeNull();
  });

  it.each([
    ["a script element", wrap("<script>alert(1)</script>")],
    ["an event handler", wrap('<rect width="10" height="10"/>', ' onload="alert(1)"')],
    ["an event handler on a child", wrap('<circle r="4" onclick="alert(1)"/>')],
    ["a javascript: link", wrap('<use href="javascript:alert(1)"/>')],
    ["an external link", wrap('<use href="https://evil.test/sprite.svg#a"/>')],
    ["a data: link", wrap('<use href="data:image/svg+xml;base64,PHN2Zz4="/>')],
    ["a link on a shape", wrap('<rect href="#a" width="1" height="1"/>')],
    ["an anchor element", wrap('<a href="#x"><rect width="1" height="1"/></a>')],
    ["foreign content", wrap("<foreignObject><div>hi</div></foreignObject>")],
    ["a style element", wrap("<style>rect{fill:url(https://evil.test/x)}</style>")],
    ["a style attribute", wrap('<rect style="fill:red" width="1" height="1"/>')],
    ["an embedded image", wrap('<image href="https://evil.test/x.png"/>')],
    ["an animation", wrap('<set attributeName="href" to="javascript:alert(1)"/>')],
    [
      "an external paint server",
      wrap('<rect fill="url(https://evil.test/p.svg#g)" width="1" height="1"/>'),
    ],
    ["an encoded javascript: URL", wrap('<use href="&#106;avascript:alert(1)"/>')],
    ["a DOCTYPE with entities", `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("<text>&x;</text>")}`],
    ["CDATA", wrap("<text><![CDATA[<script>]]></text>")],
    ["a processing instruction", `${wrap("")}<?php echo 1 ?>`],
    ["an undeclared entity", wrap("<text>&nbsp;</text>")],
    ["loose text", wrap("hello")],
    ["a missing namespace", '<svg viewBox="0 0 10 10"><rect width="1" height="1"/></svg>'],
    ["a wrong namespace", '<svg xmlns="http://evil.test/ns"><rect width="1" height="1"/></svg>'],
    ["an HTML root", '<html xmlns="http://www.w3.org/2000/svg"><body/></html>'],
    ["two roots", `${wrap("")}${wrap("")}`],
    ["an unclosed element", wrap("<g><rect/>")],
    ["mismatched tags", wrap("<g></text>")],
    ["a duplicate attribute", wrap('<rect width="1" width="2"/>')],
    ["a namespaced editor attribute", wrap('<g inkscape:label="x"/>')],
  ])("rejects an SVG with %s", (_label, svg) => {
    expect(svgLogoProblem(svg)).not.toBeNull();
    expect(logoProblem(svgUri(svg))).not.toBeNull();
    expect(messages(withPatch({ logo: { ...base.logo, src: svgUri(svg) } }))).not.toEqual([]);
  });

  it("refuses by allowlist, naming the element or attribute, even when nothing else is wrong", () => {
    // Empty elements carry no loose text, so only the allowlists can stop them.
    for (const element of ["script", "style", "foreignObject", "image", "a", "iframe", "animate"]) {
      expect(svgLogoProblem(wrap(`<${element}/>`))).toBe(
        `element "${element}" is not allowed in a logo`,
      );
    }
    for (const attribute of [
      "onload",
      "onclick",
      "style",
      "class",
      "src",
      "externalResourcesRequired",
    ]) {
      expect(svgLogoProblem(wrap(`<rect ${attribute}="x" width="1" height="1"/>`))).toBe(
        `attribute "${attribute}" is not allowed on a logo`,
      );
    }
  });

  it("rejects oversized logos", () => {
    const padding = `<path d="${"M0 0h1v1H0z".repeat(Math.ceil(maxLogoBytes / 11))}"/>`;
    const big = wrap(padding);
    expect(Buffer.byteLength(big)).toBeGreaterThan(maxLogoBytes);
    expect(svgLogoProblem(big)).toBeNull();
    expect(logoProblem(svgUri(big))).toMatch(/larger than 32 KB/);
    expect(messages(withPatch({ logo: { ...base.logo, src: svgUri(big) } }))).not.toEqual([]);
  });

  it("checks the declared type against the file's signature", () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    const webp = [...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBPVP8 ")];
    expect(logoProblem(bytesUri("image/png", png))).toBeNull();
    expect(logoProblem(bytesUri("image/webp", webp))).toBeNull();
    expect(logoProblem(bytesUri("image/png", Buffer.from(logoSvg)))).toBe("the file is not a PNG");
    expect(logoProblem(bytesUri("image/webp", png))).toBe("the file is not a WebP image");
    expect(logoProblem(bytesUri("image/svg+xml", png))).toBe("the SVG is not valid UTF-8");
  });

  it("rejects other types, encodings, and malformed data URIs", () => {
    for (const src of [
      bytesUri("image/gif", [0x47, 0x49, 0x46, 0x38]),
      bytesUri("image/svg+xml;charset=utf-8", Buffer.from(logoSvg)),
      `data:image/svg+xml,${encodeURIComponent(logoSvg)}`,
      "data:image/png;base64,iVBORw0KGgo",
      "data:image/png;base64,",
      "https://cdn.example/logo.svg",
      "/logo.svg",
    ]) {
      expect({ src: src.slice(0, 40), problem: logoProblem(src) !== null }).toEqual({
        src: src.slice(0, 40),
        problem: true,
      });
    }
  });

  it("bounds the logo's kind, alt text, and aspect ratio", () => {
    expect(messages(withPatch({ logo: { ...base.logo, kind: "banner" } }))).not.toEqual([]);
    expect(messages(withPatch({ logo: { ...base.logo, kind: "mark" } }))).toEqual([]);
    expect(messages(withPatch({ logo: { ...base.logo, alt: "" } }))).not.toEqual([]);
    expect(messages(withPatch({ logo: { ...base.logo, width: 900, height: 100 } }))).not.toEqual(
      [],
    );
    expect(messages(withPatch({ logo: { ...base.logo, width: 40, height: 100 } }))).not.toEqual([]);
    expect(messages(withPatch({ logo: { ...base.logo, width: 1.5 } }))).not.toEqual([]);
  });
});

describe("logo markup another parser could read differently", () => {
  it.each([
    [
      "a comment opened in an attribute, hiding an image with a handler",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="<!--"/><image href="x" onerror="alert(1)"/><rect fill="-->"/></svg>',
    ],
    [
      "a comment opened in an attribute, hiding a script",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="<!--"/><script>alert(1)</script><rect fill="-->"/></svg>',
    ],
    ["any comment", wrap("<!-- note -->")],
    ["a comment before the root", `<!-- note -->${wrap("")}`],
    ["a greater-than sign in an attribute", wrap('<rect fill="a>b" width="1" height="1"/>')],
    ["a less-than sign in an attribute", wrap('<rect fill="a<b" width="1" height="1"/>')],
    [
      "a declaration naming another encoding",
      `<?xml version="1.0" encoding="ISO-8859-1"?>${wrap("")}`,
    ],
    ["a UTF-16 declaration", `<?xml version="1.0" encoding='UTF-16'?>${wrap("")}`],
    ["a declaration that does not lead", ` <?xml version="1.0"?>${wrap("")}`],
    ["a stylesheet instruction", `<?xml-stylesheet href="https://evil.example/x.css"?>${wrap("")}`],
  ])("refuses %s", (_label, svg) => {
    expect(svgLogoProblem(svg)).not.toBeNull();
    expect(logoProblem(svgUri(svg))).not.toBeNull();
  });

  it("accepts only a leading UTF-8 or unlabeled XML declaration", () => {
    for (const declaration of [
      '<?xml version="1.0"?>',
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<?xml version='1.0' encoding='utf-8' standalone='yes'?>",
    ]) {
      expect(svgLogoProblem(`${declaration}\n${wrap("")}`)).toBeNull();
    }
  });
});

describe("logo references", () => {
  it.each([
    [
      "an upper-case URL()",
      wrap('<rect fill="URL(https://evil.example/p.svg#g)" width="1" height="1"/>'),
    ],
    [
      "a mixed-case Url()",
      wrap('<rect stroke="Url(https://evil.example/p.svg#g)" width="1" height="1"/>'),
    ],
    [
      "a CSS escape",
      wrap('<rect fill="u\\72l(https://evil.example/p.svg#g)" width="1" height="1"/>'),
    ],
    [
      "image-set()",
      wrap(`<rect mask="image-set('https://evil.example/x.png' 1x)" width="1" height="1"/>`),
    ],
    ["a color function", wrap('<rect fill="rgb(1,2,3)" width="1" height="1"/>')],
    ["a backslash", wrap('<rect fill="#ffffff\\" width="1" height="1"/>')],
    ["a function inside a transform", wrap('<g transform="translate(url(#a))"/>')],
    ["a use element", wrap('<use href="#a"/>')],
    ["a symbol element", wrap('<symbol id="a"/>')],
    [
      "xlink without its namespace",
      '<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="a"/><linearGradient id="b" xlink:href="#a"/></svg>',
    ],
    [
      "a gradient link to another document",
      wrap('<linearGradient href="https://evil.example/g.svg#a"/>'),
    ],
    [
      "a mask inside a mask",
      wrap('<mask id="a"><rect mask="url(#b)" width="1" height="1"/></mask>'),
    ],
    [
      "a clip path inside a clip path",
      wrap('<clipPath id="a"><rect clip-path="url(#b)" width="1" height="1"/></clipPath>'),
    ],
    ["a reference on the mask itself", wrap('<mask id="a" mask="url(#b)"/>')],
    ["more than a thousand elements", wrap("<g/>".repeat(1000))],
  ])("refuses %s", (_label, svg) => {
    expect(svgLogoProblem(svg)).not.toBeNull();
  });

  it("accepts local paint references, gradient links, and plain transforms", () => {
    expect(
      svgLogoProblem(
        wrap(
          '<linearGradient id="g"/><linearGradient id="h" href="#g"/><g transform="translate(4 4) rotate(45 5 5) scale(1.5) matrix(1 0 0 1 0 0) skewX(10)"><rect fill="url(#h)" width="1" height="1"/></g>',
        ),
      ),
    ).toBeNull();
    expect(svgLogoProblem(wrap("<g/>".repeat(990)))).toBeNull();
  });
});

describe("pattern cost", () => {
  /** Run a check and return its result and how long it took, in milliseconds. */
  function timed<T>(check: () => T): { result: T; ms: number } {
    const start = performance.now();
    const result = check();
    return { result, ms: performance.now() - start };
  }

  // Single spaces first. With two `\s*` around an optional comma, these took
  // about 0.7 s, double spaces 21 s, and triple spaces never finished.
  it.each([1, 2, 3])(
    "rejects a failing transform list near 200 characters quickly, %i-space gaps",
    (width) => {
      const unit = `scale(1)${" ".repeat(width)}`;
      const list = unit.repeat(Math.floor(199 / unit.length));
      const value = `${list}x`;
      expect(value.length).toBeGreaterThan(185);
      expect(value.length).toBeLessThanOrEqual(200);
      const failing = timed(() => svgLogoProblem(wrap(`<g transform="${value}"/>`)));
      expect(failing.result).toMatch(/plain list of transforms/);
      expect(failing.ms).toBeLessThan(50);
      // The same list without the stray character is a valid transform.
      expect(svgLogoProblem(wrap(`<g transform="${list}"/>`))).toBeNull();
    },
  );

  it("keeps every other logo, link, and copy check fast on hostile input at its size limit", () => {
    const attributes = ' fill="#000"'.repeat(2500);
    const cases: Array<[string, () => unknown]> = [
      ["an unclosed tag full of attributes", () => svgLogoProblem(`<svg${attributes}`)],
      ["a tag padded with whitespace", () => svgLogoProblem(`<svg${" ".repeat(30_000)}x`)],
      [
        "an XML declaration padded with whitespace",
        () => svgLogoProblem(`<?xml version="1.0"${" ".repeat(30_000)}?x`),
      ],
      [
        "script-like words followed by whitespace",
        () => svgLogoProblem(wrap(`<rect fill="${"expression ".repeat(2500)}x"/>`)),
      ],
      [
        "a data URI that fails on its last character",
        () => logoProblem(`data:image/png;base64,${"A".repeat(43_900)}!`),
      ],
      [
        "a hostname of many labels that fails at the end",
        () => isHttpsUrl(`https://${"a.".repeat(120)}!`),
      ],
      ["a single long label", () => isHttpsUrl(`https://${"a-".repeat(120)}a!`)],
      [
        "copy that fails on its last character",
        () => PublicTenantIdentity.safeParse({ slug: "a".repeat(40), name: `${"x ".repeat(60)}<` }),
      ],
    ];
    for (const [label, check] of cases) {
      expect({ label, fast: timed(check).ms < 50 }).toEqual({ label, fast: true });
    }
  });
});

describe("public tenant identity", () => {
  it("is a closed shape with a slug and a plain, bounded name", () => {
    const ok = { slug: "demo-harbor", name: "Demo Harbor Charters" };
    expect(PublicTenantIdentity.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, id: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01" },
      { ...ok, slug: "Demo-Harbor" },
      { ...ok, slug: "-harbor" },
      { ...ok, slug: "a".repeat(41) },
      { ...ok, name: "" },
      { ...ok, name: "x".repeat(121) },
      { ...ok, name: "Harbor‮" },
      { ...ok, name: "<b>Harbor</b>" },
    ]) {
      expect(PublicTenantIdentity.safeParse(bad).success).toBe(false);
    }
  });
});

describe("public brand shapes", () => {
  it("adds a positive version to the stored brand", () => {
    expect(PublicBrand.safeParse({ ...base, version: 3 }).success).toBe(true);
    expect(PublicBrand.safeParse(base).success).toBe(false);
    expect(PublicBrand.safeParse({ ...base, version: 0 }).success).toBe(false);
  });

  it("keeps the contrast rules on the public brand too", () => {
    const low = { ...base, version: 1, colors: { primary: "#a7d129", accent: "#0e2b1f" } };
    expect(PublicBrand.safeParse(low).success).toBe(false);
  });

  it("lets the bootstrap omit the brand but never carry an invalid one", () => {
    const tenant = { slug: "demo-harbor", name: "Demo Harbor Charters" };
    expect(PublicExperienceResponse.safeParse({ tenant }).success).toBe(true);
    expect(
      PublicExperienceResponse.safeParse({ tenant, brand: { ...base, version: 1 } }).success,
    ).toBe(true);
    expect(
      PublicExperienceResponse.safeParse({
        tenant,
        brand: { ...base, version: 1, name: "<b>x</b>" },
      }).success,
    ).toBe(false);
  });
});
