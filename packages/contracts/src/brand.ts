import { z } from "zod";

/**
 * Tenant brand contract. This file is the single source of truth for what a
 * tenant may set on its guest surfaces (`BrandConfigVersion` in the target
 * architecture): a logo, a primary and an accent color, a display and a body
 * font from the supported set, short copy, contact details, legal links, a
 * locale, and the enabled guest capabilities. Nothing else. No field carries
 * markup or style, and every value is checked here, at each boundary that
 * reads it: the manifest loader, the database seed, the API, and the browser.
 *
 * `@tidegrid/design-system/brand` re-exports these schemas together with the
 * font faces and the mapping to CSS variables. This module imports nothing but
 * zod, so the API Worker can use it without pulling in React or CSS.
 */

// Colors and contrast ----------------------------------------------------------

/** Lowercase six-digit hex. No alpha, no shorthand, no color names. */
export const HexColor = z
  .string()
  .regex(/^#[0-9a-f]{6}$/, "Use a six-digit lowercase hex color, for example #0b3c5d");
export type HexColor = z.infer<typeof HexColor>;

/** WCAG 2.2 thresholds: text, large text, and user-interface components. */
export const contrastMinimums = { text: 4.5, largeText: 3, ui: 3 } as const;

/**
 * Fixed guest-surface colors. Tenants choose the primary and the accent; the
 * page stays Foam with Deep Forest text, so body contrast never depends on
 * tenant input.
 */
export const guestSurface = { page: "#f6f7f6", ink: "#0e2b1f", white: "#ffffff" } as const;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a six-digit hex color. */
export function relativeLuminance(hex: string): number {
  const parsed = HexColor.safeParse(hex);
  if (!parsed.success) throw new TypeError(`not a six-digit lowercase hex color: ${hex}`);
  const n = Number.parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Text color for content on a primary-colored surface: white or Deep Forest,
 * whichever contrasts more.
 */
export function primaryInk(primary: string): "#ffffff" | "#0e2b1f" {
  return contrastRatio(primary, guestSurface.white) >= contrastRatio(primary, guestSurface.ink)
    ? guestSurface.white
    : guestSurface.ink;
}

/** Rounded down, so a ratio just under a threshold never prints as passing. */
const ratio = (n: number) => `${(Math.floor(n * 100) / 100).toFixed(2)}:1`;

/**
 * The contrast rules a brand must pass, as messages; an empty list passes.
 * - The primary color is used for links and the primary action on the light
 *   page, so it needs 4.5:1 against the page.
 * - Text on a primary surface uses the better of white and Deep Forest, which
 *   needs 4.5:1.
 * - The accent marks rules, selection, and focus on the primary surface, so it
 *   needs 3:1 against the primary.
 * Colors that are not valid hex are left to the field validation that reports
 * them, and produce no contrast message here.
 */
export function brandContrastProblems(colors: { primary: string; accent: string }): string[] {
  if (!HexColor.safeParse(colors.primary).success || !HexColor.safeParse(colors.accent).success) {
    return [];
  }
  const problems: string[] = [];
  const onPage = contrastRatio(colors.primary, guestSurface.page);
  if (onPage < contrastMinimums.text) {
    problems.push(
      `Primary ${colors.primary} has ${ratio(onPage)} contrast with the page ${guestSurface.page}; it needs ${contrastMinimums.text}:1`,
    );
  }
  const ink = primaryInk(colors.primary);
  const withInk = contrastRatio(colors.primary, ink);
  if (withInk < contrastMinimums.text) {
    problems.push(
      `Text on primary ${colors.primary} reaches only ${ratio(withInk)}; it needs ${contrastMinimums.text}:1`,
    );
  }
  const accent = contrastRatio(colors.accent, colors.primary);
  if (accent < contrastMinimums.ui) {
    problems.push(
      `Accent ${colors.accent} has ${ratio(accent)} contrast with primary ${colors.primary}; it needs ${contrastMinimums.ui}:1`,
    );
  }
  return problems;
}

// Fonts ------------------------------------------------------------------------

/**
 * Supported fonts, at most three per role. Every one is licensed under the SIL
 * Open Font License and self-hosted by `@tidegrid/design-system`, so the
 * content security policy never needs a font origin. The first entry in each
 * list is the TideGrid default.
 */
export const displayFontIds = ["sora", "fraunces", "bricolage-grotesque"] as const;
export const bodyFontIds = ["inter", "source-sans-3", "atkinson-hyperlegible-next"] as const;
export const DisplayFont = z.enum(displayFontIds);
export const BodyFont = z.enum(bodyFontIds);
export type DisplayFont = z.infer<typeof DisplayFont>;
export type BodyFont = z.infer<typeof BodyFont>;

// Text and links ---------------------------------------------------------------

/**
 * No control characters (Cc, including U+0085), no format characters (Cf:
 * bidi overrides, zero-width characters, the byte order mark), no line or
 * paragraph separators, no lone surrogates, and no angle brackets.
 */
const plainText = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}<>]*$/u;
const unsafeUrlCharacter = /[\s\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * Plain single-line copy. React escapes text, but copy also reaches email and
 * other renderers later, so angle brackets and invisible or reordering
 * characters are refused here rather than trusted to every template.
 */
const BrandText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(plainText, "Use plain text without angle brackets or control characters")
    .refine((v) => v === v.trim(), "Remove leading and trailing spaces")
    // The OpenAPI generator writes a flagged regex as "source/u", which matches
    // nothing. Publish the bare source; JSON Schema validators apply the u flag.
    // Consumers need a Unicode-aware engine (JSON Schema 2020-12 u-flag behavior) for \p{...}.
    .meta({ pattern: plainText.source });

const hostnamePattern =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether a string is an absolute https URL with a DNS hostname and no credentials. */
export function isHttpsUrl(value: string): boolean {
  if (value.length > 300 || unsafeUrlCharacter.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    value.toLowerCase().startsWith(`https://${url.hostname}`) &&
    hostnamePattern.test(url.hostname)
  );
}

export const HttpsUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/[^/\\]/, "Use an absolute https:// link")
  .refine(isHttpsUrl, "Use an absolute https:// link with a hostname and no credentials");

/**
 * A path on the guest site's own origin. It must start with one slash and may
 * not start with two or contain a backslash, which browsers read as another
 * origin (`//host` and `/\host`).
 */
export const SameOriginPath = z
  .string()
  .max(200)
  .regex(
    /^\/(?!\/)[A-Za-z0-9\-._~%!$&'()*+,;=:@/?#]*$/,
    "Use a path on this site, such as /legal/terms",
  );

export const LinkTarget = z.union([HttpsUrl, SameOriginPath]);

const EmailAddress = z
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/, "Addresses must be ASCII");

/** E.164, for example +13055550142. Synthetic tenants use the 555-01xx range. */
export const PhoneNumber = z
  .string()
  .regex(/^\+[1-9][0-9]{7,14}$/, "Use E.164, such as +13055550142");

// Logo ---------------------------------------------------------------------------

/** Largest accepted logo, decoded. */
export const maxLogoBytes = 32 * 1024;
const maxLogoSrcLength = 44_000;
export const logoMediaTypes = ["image/svg+xml", "image/png", "image/webp"] as const;
export type LogoMediaType = (typeof logoMediaTypes)[number];

const dataUriPattern =
  /^data:(image\/svg\+xml|image\/png|image\/webp);base64,([A-Za-z0-9+/]+={0,2})$/;

const svgNamespace = "http://www.w3.org/2000/svg";
const xlinkNamespace = "http://www.w3.org/1999/xlink";

/** Elements a logo may use: shapes, groups, gradients, clipping, and text. */
const svgElements = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
]);

/** Presentation and geometry attributes. No event handlers, no style, no class. */
const svgAttributes = new Set([
  "id",
  "x",
  "y",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "transform",
  "version",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "fx",
  "fy",
  "fr",
  "dx",
  "dy",
  "points",
  "pathLength",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "color",
  "display",
  "visibility",
  "clip-path",
  "clip-rule",
  "mask",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "text-rendering",
  "role",
  "aria-label",
  "aria-hidden",
  "focusable",
  "xmlns",
  "xmlns:xlink",
  "xml:space",
  "href",
  "xlink:href",
]);

/** Gradients may inherit from another gradient in the same document. */
const referencingElements = new Set(["linearGradient", "radialGradient"]);
/**
 * Mask and clip-path content renders once for every element that references
 * it. A reference nested inside that content would multiply the work at each
 * level, so masks and clip paths may not reference anything themselves.
 */
const referencedContainers = new Set(["mask", "clipPath"]);
const containerReferences = new Set(["mask", "clip-path", "href", "xlink:href"]);
const textElements = new Set(["title", "desc", "text", "tspan"]);
const maxSvgElements = 1000;
const localReference = /^#[A-Za-z_][\w.-]*$/;
const localUrlReference = /^url\(#[A-Za-z_][\w.-]*\)$/;
const svgNumber = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;
/**
 * A plain SVG transform list: numbers only, no nested functions. Every run of
 * whitespace has exactly one quantifier that can take it. Between transforms
 * that is `\s*(?:,\s*)?`, never `\s*,?\s*`: with the comma absent, two `\s*`
 * split the same run many ways, and a failing value under the 200-character
 * cap backtracked for up to a minute.
 */
const transformList = new RegExp(
  String.raw`^\s*(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*${svgNumber}(?:(?:\s*,\s*|\s+)${svgNumber})*\s*\)\s*(?:,\s*)?)+$`,
);
/** Matched against the lowercased value. */
const dangerousValue = /javascript:|vbscript:|data:|expression\s*\(|@import/;
const attributePattern = /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/y;
const tagPattern =
  /<(\/?)([A-Za-z][A-Za-z0-9_.:-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>/y;
/** The only prolog allowed: a leading declaration, UTF-8 or unlabeled. */
const xmlDeclaration =
  /^<\?xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+encoding\s*=\s*(["'])([A-Za-z][\w.-]*)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\4)?\s*\?>/;
/** Entities that need no DTD. Attribute values may not use numeric references. */
const textEntity = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/;
const attributeEntity = /&(?!(?:amp|lt|gt|quot|apos);)/;

interface AttributeScope {
  /** The attribute sits on the root <svg>. */
  root: boolean;
  /** The root declared the xlink namespace. */
  xlink: boolean;
  /** The element is a mask or clip path, or lies inside one. */
  inReferencedContainer: boolean;
}

function attributeProblem(
  element: string,
  name: string,
  value: string,
  scope: AttributeScope,
): string | null {
  if (!svgAttributes.has(name)) return `attribute "${name}" is not allowed on a logo`;
  if (attributeEntity.test(value)) return `attribute "${name}" uses a character reference`;
  if (value.includes("\\")) return `attribute "${name}" contains a backslash`;
  if (name === "xmlns") return value === svgNamespace ? null : "the SVG namespace is wrong";
  if (name === "xmlns:xlink") {
    if (!scope.root) return "declare the xlink namespace on the root <svg> only";
    return value === xlinkNamespace ? null : "the xlink namespace is wrong";
  }
  if (name.startsWith("xlink:") && !scope.xlink) {
    return `attribute "${name}" needs the xlink namespace declared on the root <svg>`;
  }
  if (scope.inReferencedContainer && containerReferences.has(name)) {
    return `attribute "${name}" may not appear on or inside a mask or clip path`;
  }
  if (name === "href" || name === "xlink:href") {
    if (!referencingElements.has(element)) return `"${element}" may not carry a link`;
    return localReference.test(value) ? null : "links may only point inside the logo (#id)";
  }
  if (dangerousValue.test(value.toLowerCase())) {
    return `attribute "${name}" contains a script or external reference`;
  }
  if (name === "transform" || name === "gradientTransform") {
    return value.length <= 200 && transformList.test(value)
      ? null
      : `attribute "${name}" must be a plain list of transforms`;
  }
  if (value.includes("(") || value.includes(")")) {
    return localUrlReference.test(value.trim())
      ? null
      : `attribute "${name}" may only reference inside the logo, as url(#id); colors must be hex`;
  }
  return null;
}

/**
 * Check an SVG document against a strict allowlist. Returns the first problem,
 * or null when the logo is safe to publish. Browsers never run scripts in an
 * SVG shown as an image (an `<img>` element or the tab icon), and the guest
 * surfaces only ever show it that way, but a logo must be inert in any
 * renderer, so anything outside plain shapes, paint, gradients, clipping,
 * masks, and text is refused.
 *
 * The scanner reads the document exactly as written. It never strips or
 * rewrites anything first, so it cannot see a different document than an XML
 * or HTML parser would: comments, a DOCTYPE, CDATA, and processing
 * instructions are refused outright, and attribute values may not contain `<`,
 * `>`, or a backslash.
 */
export function svgLogoProblem(source: string): string | null {
  let s = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const declaration = xmlDeclaration.exec(s);
  if (declaration) {
    const encoding = declaration[3];
    if (encoding !== undefined && encoding.toLowerCase() !== "utf-8") {
      return "an SVG logo must be UTF-8";
    }
    s = s.slice(declaration[0].length);
  }
  if (/<[!?]/.test(s)) {
    return "SVG logos may not contain comments, a DOCTYPE, CDATA, or processing instructions";
  }
  const stack: string[] = [];
  let sawRoot = false;
  let xlink = false;
  let elements = 0;
  let pos = 0;
  while (pos < s.length) {
    const lt = s.indexOf("<", pos);
    const text = s.slice(pos, lt === -1 ? s.length : lt);
    if (text.length > 0) {
      if (textEntity.test(text)) return "the logo uses an entity that needs a DTD";
      if (text.trim().length > 0) {
        const parent = stack.at(-1);
        if (!parent || !textElements.has(parent)) return "the logo has text outside a text element";
      }
    }
    if (lt === -1) break;
    tagPattern.lastIndex = lt;
    const tag = tagPattern.exec(s);
    if (!tag) return "the logo is not well-formed SVG";
    const [whole, closing, name = "", rawAttributes = "", selfClosing] = tag;
    if (!svgElements.has(name)) return `element "${name}" is not allowed in a logo`;
    if (closing) {
      if (rawAttributes.length > 0 || selfClosing) return "the logo is not well-formed SVG";
      if (stack.pop() !== name) return "the logo is not well-formed SVG";
    } else {
      elements += 1;
      if (elements > maxSvgElements) return `a logo may have at most ${maxSvgElements} elements`;
      const root = stack.length === 0;
      if (root) {
        if (sawRoot || name !== "svg") return "a logo must be a single <svg> element";
        sawRoot = true;
      }
      if (stack.length >= 32) return "the logo nests too deeply";
      const attributes: Array<[string, string]> = [];
      let rest = 0;
      while (rest < rawAttributes.length) {
        attributePattern.lastIndex = rest;
        const attr = attributePattern.exec(rawAttributes);
        if (!attr) return "the logo is not well-formed SVG";
        const attrName = attr[1] ?? "";
        if (attributes.some(([seen]) => seen === attrName)) {
          return `attribute "${attrName}" appears twice`;
        }
        attributes.push([attrName, attr[2] ?? attr[3] ?? ""]);
        rest = attributePattern.lastIndex;
      }
      if (root) {
        if (!attributes.some(([n]) => n === "xmlns")) {
          return "the root <svg> must declare the SVG namespace";
        }
        xlink = attributes.some(([n, v]) => n === "xmlns:xlink" && v === xlinkNamespace);
      }
      const scope: AttributeScope = {
        root,
        xlink,
        inReferencedContainer:
          referencedContainers.has(name) || stack.some((n) => referencedContainers.has(n)),
      };
      for (const [attrName, value] of attributes) {
        const problem = attributeProblem(name, attrName, value, scope);
        if (problem) return problem;
      }
      if (!selfClosing) stack.push(name);
    }
    pos = lt + whole.length;
  }
  if (!sawRoot) return "a logo must be a single <svg> element";
  if (stack.length > 0) return "the logo is not well-formed SVG";
  return null;
}

function decodeBase64(data: string): Uint8Array | null {
  if (data.length % 4 !== 0) return null;
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const startsWith = (bytes: Uint8Array, prefix: number[], at = 0) =>
  prefix.every((b, i) => bytes[at + i] === b);

/**
 * Check a logo data URI: type, encoding, size, content signature, and for SVG
 * the allowlist above. Returns the first problem, or null.
 */
export function logoProblem(src: string): string | null {
  if (src.length > maxLogoSrcLength) return `the logo is larger than ${maxLogoBytes / 1024} KB`;
  const match = dataUriPattern.exec(src);
  if (!match) return "a logo must be a base64 data URI of type SVG, PNG, or WebP";
  const [, type, data = ""] = match;
  const bytes = decodeBase64(data);
  if (!bytes) return "the logo is not valid base64";
  if (bytes.length === 0) return "the logo is empty";
  if (bytes.length > maxLogoBytes) return `the logo is larger than ${maxLogoBytes / 1024} KB`;
  if (type === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? null
      : "the file is not a PNG";
  }
  if (type === "image/webp") {
    return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      ? null
      : "the file is not a WebP image";
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return "the SVG is not valid UTF-8";
  }
  return svgLogoProblem(text);
}

export const BrandLogo = z
  .strictObject({
    src: z
      .string()
      .max(maxLogoSrcLength)
      .regex(dataUriPattern, "Use a base64 data URI of type SVG, PNG, or WebP")
      .superRefine((src, ctx) => {
        const problem = logoProblem(src);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      })
      .describe(
        "Base64 data URI, SVG, PNG, or WebP, at most 32 KB decoded. SVG is limited to inert shapes, paint, gradients, clipping, and text. Render only as an image (an <img> element or the tab icon).",
      ),
    kind: z
      .enum(["mark", "lockup"])
      .describe(
        "mark: a symbol, shown beside the brand name set in the display font. lockup: artwork that already contains the name, shown alone.",
      ),
    alt: BrandText(120),
    width: z.int().min(16).max(4096).describe("Intrinsic width; sets the aspect ratio"),
    height: z.int().min(16).max(4096).describe("Intrinsic height; sets the aspect ratio"),
  })
  .refine(
    (logo) => logo.width / logo.height >= 0.5 && logo.width / logo.height <= 8,
    "A logo's aspect ratio must be between 1:2 and 8:1",
  );
export type BrandLogo = z.infer<typeof BrandLogo>;

// Brand configuration --------------------------------------------------------------

/**
 * Optional guest modules, one per staged Core module. An operator goes live
 * with all of them off; enabling one is per-operator configuration.
 */
export const GuestCapability = z.enum([
  "transactional_sms",
  "pooled_equipment",
  "marine_conditions",
  "tips",
  "trip_cards",
]);
export type GuestCapability = z.infer<typeof GuestCapability>;

/** Guest copy is English until it is localized; `lang` must match the text. */
export const BrandLocale = z.enum(["en-US"]);
export type BrandLocale = z.infer<typeof BrandLocale>;

export const BrandColors = z.strictObject({
  primary: HexColor.describe("Links and the single primary action; 4.5:1 against the page"),
  accent: HexColor.describe("Rules, marks, and focus on the primary surface; 3:1 against primary"),
});

export const BrandFonts = z.strictObject({ display: DisplayFont, body: BodyFont });

export const BrandContact = z
  .strictObject({
    email: EmailAddress.optional(),
    phone: PhoneNumber.optional(),
    website: HttpsUrl.optional(),
  })
  .refine(
    (c) => c.email !== undefined || c.phone !== undefined,
    "Give an email address or a phone number",
  );

export const BrandLegal = z.strictObject({ terms: LinkTarget, privacy: LinkTarget });

/** Brand fields without cross-field rules, so the public shape can extend it. */
const brandConfigShape = z.strictObject({
  name: BrandText(80).describe("Guest-facing brand name"),
  tagline: BrandText(140).optional(),
  colors: BrandColors,
  fonts: BrandFonts,
  logo: BrandLogo.optional(),
  contact: BrandContact,
  legal: BrandLegal,
  locale: BrandLocale,
  capabilities: z
    .array(GuestCapability)
    .max(GuestCapability.options.length)
    .refine((list) => new Set(list).size === list.length, "List each capability once"),
});

/**
 * Cross-field contrast rules. Zod can run this even when a field already
 * failed, so it reads the colors defensively and leaves shape errors to the
 * field validators.
 */
const checkContrast = (brand: { colors?: unknown }, ctx: z.RefinementCtx) => {
  const colors = brand.colors as { primary?: unknown; accent?: unknown } | null | undefined;
  if (typeof colors?.primary !== "string" || typeof colors.accent !== "string") return;
  for (const message of brandContrastProblems({ primary: colors.primary, accent: colors.accent })) {
    ctx.addIssue({ code: "custom", message, path: ["colors"] });
  }
};

/** The stored contents of one immutable brand configuration version. */
export const BrandConfig = brandConfigShape.superRefine(checkContrast);
export type BrandConfig = z.infer<typeof BrandConfig>;

/** Version of the `BrandConfig` shape stored with each row. */
export const brandSchemaVersion = 1;

/** The active brand as the public bootstrap returns it. */
export const PublicBrand = brandConfigShape
  .extend({
    version: z.int().positive().describe("Per-tenant brand configuration version"),
  })
  .superRefine(checkContrast);
export type PublicBrand = z.infer<typeof PublicBrand>;

/** Tenant slug, as the tenants table constrains it. */
export const TenantSlug = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, "Use a lowercase slug such as demo-harbor");

/** The tenant as the public bootstrap names it. Nothing else about the tenant is public. */
export const PublicTenantIdentity = z.strictObject({
  slug: TenantSlug,
  name: BrandText(120).describe("Operator display name"),
});

export const PublicExperienceResponse = z
  .object({
    tenant: PublicTenantIdentity,
    brand: PublicBrand.optional().describe(
      "The tenant's active brand. Absent until the tenant publishes one; a guest surface must not render without it.",
    ),
  })
  .describe(
    "Public experience bootstrap for a verified hostname: tenant identity and active brand. Grants no permission.",
  );
export type PublicExperienceResponse = z.infer<typeof PublicExperienceResponse>;
