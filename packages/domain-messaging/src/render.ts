/**
 * Branded email rendering: structured blocks in, HTML and plain text out.
 * Pure; runs in Workers and Node.
 *
 * Every text a caller gives is escaped, so tenant and guest content (an
 * operator's name, a booker's name, a trip's name) can never become markup.
 * The layout is table-based with inline styles, the form email clients
 * render, and keeps the guest surface's fixed colors: Foam page, Deep Forest
 * text, the operator's primary color behind its name and its one button, with
 * the text color on it chosen for contrast (`primaryInk`).
 *
 * An access link is never rendered here. Its place in the bodies is a marker
 * naming a random slot; the delivery job issues the token at send time and
 * replaces the marker with the URL (`fillLinkSlot`).
 */
import { guestSurface, primaryInk } from "@tidegrid/contracts";

/** What a message says, as blocks; never markup. */
export type EmailBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  /** A table of labels and values, such as a trip's date and meeting point. */
  | { kind: "details"; rows: { label: string; value: string }[] }
  /** A receipt: labels and amounts already formatted; a strong row is a total. */
  | { kind: "lines"; rows: { label: string; amount: string; strong?: boolean }[] }
  /** The message's one button: the access link issued at send time, or an https URL. */
  | { kind: "action"; label: string; href: "access_link" | `https://${string}` }
  /** A quieter aside, such as how long a link lasts. */
  | { kind: "note"; text: string };

export interface EmailContent {
  /** One line, at most 200 characters. */
  subject: string;
  /** The inbox preview line; defaults to nothing. */
  preview?: string;
  blocks: EmailBlock[];
}

export interface EmailBrand {
  /** The operator's guest-facing name. */
  name: string;
  /** Six-digit lowercase hex, contrast-checked against the guest page. */
  primary: string;
  accent: string;
  /** Shown in the footer and used as the reply-to address. */
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The neutral TideGrid brand, for a tenant that has not published one. */
export const neutralBrandColors = { primary: "#143f2e", accent: "#a7d129" } as const;

const ink = guestSurface.ink;
const page = guestSurface.page;
const mist = "#e8ece8";
const muted = "#3d4a44";
const font = "Arial, Helvetica, sans-serif";

/** The marker an access link's URL replaces at send time. */
export function linkMarker(slot: string): string {
  if (!/^[0-9a-f]{32}$/.test(slot)) throw new TypeError("a link slot is 32 lowercase hex digits");
  return `{{tidegrid-link:${slot}}}`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern exists to reject them.
const anyControl = /[\u0000-\u001f\u007f-\u009f]/;

function checkText(text: string, what: string, max: number): string {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > max) {
    throw new TypeError(`${what} must be 1 to ${max} characters`);
  }
  if (controls.test(text)) throw new TypeError(`${what} must not contain control characters`);
  return text;
}

function checkHttps(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new TypeError("an action's link must be an absolute https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("an action's link must be an absolute https URL");
  }
  return url.href;
}

/**
 * Check a message's content before it is rendered or stored. Programmer
 * errors throw: callers build content in code, never from a request.
 */
export function checkContent(content: EmailContent): void {
  // One line each, with no control at all: the database refuses a tab in a subject too.
  const subject = checkText(content.subject, "a subject", 200);
  if (anyControl.test(subject))
    throw new TypeError("a subject is one line, with no control characters");
  if (content.preview !== undefined) {
    const preview = checkText(content.preview, "a preview", 200);
    if (anyControl.test(preview))
      throw new TypeError("a preview is one line, with no control characters");
  }
  if (!Array.isArray(content.blocks) || content.blocks.length === 0 || content.blocks.length > 60) {
    throw new TypeError("a message has 1 to 60 blocks");
  }
  let actions = 0;
  for (const block of content.blocks) {
    switch (block.kind) {
      case "heading":
        checkText(block.text, "a heading", 200);
        break;
      case "paragraph":
      case "note":
        checkText(block.text, `a ${block.kind}`, 2000);
        break;
      case "details":
        if (block.rows.length === 0 || block.rows.length > 40) {
          throw new TypeError("a details block has 1 to 40 rows");
        }
        for (const row of block.rows) {
          checkText(row.label, "a details label", 120);
          checkText(row.value, "a details value", 1000);
        }
        break;
      case "lines":
        if (block.rows.length === 0 || block.rows.length > 120) {
          throw new TypeError("a lines block has 1 to 120 rows");
        }
        for (const row of block.rows) {
          checkText(row.label, "a line's label", 200);
          checkText(row.amount, "a line's amount", 40);
        }
        break;
      case "action":
        actions += 1;
        checkText(block.label, "an action's label", 80);
        if (block.href !== "access_link") checkHttps(block.href);
        break;
      default:
        throw new TypeError(`unknown block kind ${String((block as { kind?: unknown }).kind)}`);
    }
  }
  if (actions > 1) throw new TypeError("a message has at most one action");
}

/** Whether the content's action is the access link issued at send time. */
export function usesAccessLink(content: EmailContent): boolean {
  return content.blocks.some((b) => b.kind === "action" && b.href === "access_link");
}

function htmlBlock(block: EmailBlock, brand: EmailBrand, link: string | null): string {
  switch (block.kind) {
    case "heading":
      return `<h1 style="margin:0 0 16px;font-family:${font};font-size:24px;line-height:1.25;font-weight:700;color:${ink};">${escapeHtml(block.text)}</h1>`;
    case "paragraph":
      return `<p style="margin:0 0 16px;">${escapeHtml(block.text)}</p>`;
    case "note":
      return `<p style="margin:0 0 16px;padding:12px 16px;background:${page};border-left:4px solid ${brand.primary};font-size:14px;color:${muted};">${escapeHtml(block.text)}</p>`;
    case "details":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse;">${block.rows
        .map(
          (row) =>
            `<tr><th scope="row" align="left" valign="top" style="padding:8px 12px 8px 0;border-bottom:1px solid ${mist};font-family:${font};font-size:14px;font-weight:700;color:${muted};width:38%;">${escapeHtml(row.label)}</th><td valign="top" style="padding:8px 0;border-bottom:1px solid ${mist};font-family:${font};font-size:15px;color:${ink};">${escapeHtml(row.value)}</td></tr>`,
        )
        .join("")}</table>`;
    case "lines":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse;">${block.rows
        .map((row) => {
          const weight = row.strong ? "700" : "400";
          const top = row.strong ? `border-top:2px solid ${ink};` : `border-top:1px solid ${mist};`;
          return `<tr><td style="padding:8px 12px 8px 0;${top}font-family:${font};font-size:15px;font-weight:${weight};color:${ink};">${escapeHtml(row.label)}</td><td align="right" style="padding:8px 0;${top}font-family:${font};font-size:15px;font-weight:${weight};color:${ink};white-space:nowrap;">${escapeHtml(row.amount)}</td></tr>`;
        })
        .join("")}</table>`;
    case "action": {
      const href = block.href === "access_link" ? link : block.href;
      if (href === null) throw new TypeError("an access-link action needs a link slot");
      const onPrimary = primaryInk(brand.primary);
      const shown = escapeHtml(href);
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;"><tr><td style="border-radius:8px;background:${brand.primary};"><a href="${shown}" style="display:inline-block;padding:14px 24px;font-family:${font};font-size:16px;font-weight:700;line-height:1;color:${onPrimary};text-decoration:none;border-radius:8px;">${escapeHtml(block.label)}</a></td></tr></table><p style="margin:0 0 16px;font-size:14px;color:${muted};">If the button does not work, copy this address into your browser:<br><a href="${shown}" style="color:${ink};word-break:break-all;">${shown}</a></p>`;
    }
  }
}

function textBlock(block: EmailBlock, link: string | null): string {
  switch (block.kind) {
    case "heading":
      return block.text.toUpperCase();
    case "paragraph":
    case "note":
      return block.text;
    case "details":
      return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    case "lines":
      return block.rows
        .map((row) =>
          row.strong ? `${row.label}: ${row.amount}` : `  ${row.label}: ${row.amount}`,
        )
        .join("\n");
    case "action": {
      const href = block.href === "access_link" ? link : block.href;
      if (href === null) throw new TypeError("an access-link action needs a link slot");
      return `${block.label}:\n${href}`;
    }
  }
}

/**
 * A phone number as a guest reads it: a North American one as (305) 555-0142,
 * as the booking site shows it; any other as stored, in E.164.
 */
export function displayPhone(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}

function footerParts(brand: EmailBrand): string[] {
  const contact = [
    brand.contactEmail,
    brand.contactPhone ? displayPhone(brand.contactPhone) : null,
  ].filter((v): v is string => !!v);
  return [
    contact.length ? `Questions? Contact ${brand.name}: ${contact.join(", ")}.` : null,
    `Sent by TideGrid for ${brand.name}. TideGrid demo build: the operator and its trips are synthetic, and no real booking or payment is made.`,
  ].filter((v): v is string => v !== null);
}

/**
 * Render a message. With `slot`, an access-link action points at the slot's
 * marker, which the delivery job replaces with the URL when it sends.
 */
export function renderEmail(
  brand: EmailBrand,
  content: EmailContent,
  options: { slot?: string | null } = {},
): RenderedEmail {
  checkContent(content);
  const link = options.slot ? linkMarker(options.slot) : null;
  if (usesAccessLink(content) && !link) {
    throw new TypeError("content with an access-link action needs a link slot");
  }
  const onPrimary = primaryInk(brand.primary);
  const preview = content.preview
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(content.preview)}</div>`
    : "";
  const body = content.blocks.map((b) => htmlBlock(b, brand, link)).join("");
  const footer = footerParts(brand)
    .map((p) => `<p style="margin:0 0 8px;">${escapeHtml(p)}</p>`)
    .join("");
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeHtml(content.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:${page};">`,
    preview,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${page};">`,
    '<tr><td align="center" style="padding:24px 12px;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${mist};border-radius:12px;">`,
    `<tr><td style="background:${brand.primary};padding:20px 24px;border-radius:12px 12px 0 0;font-family:${font};font-size:20px;line-height:1.3;font-weight:700;color:${onPrimary};">${escapeHtml(brand.name)}</td></tr>`,
    `<tr><td style="padding:24px;font-family:${font};font-size:16px;line-height:1.5;color:${ink};">${body}</td></tr>`,
    `<tr><td style="padding:16px 24px 24px;border-top:1px solid ${mist};font-family:${font};font-size:13px;line-height:1.5;color:${muted};">${footer}</td></tr>`,
    "</table></td></tr></table></body></html>",
  ].join("");
  const text = [
    brand.name,
    "",
    ...content.blocks.flatMap((b) => [textBlock(b, link), ""]),
    "--",
    ...footerParts(brand),
    "",
  ].join("\n");
  return { subject: content.subject, html, text };
}

/** Replace a slot's marker with the access link's URL, everywhere it appears. */
export function fillLinkSlot(body: string, slot: string, url: string): string {
  const marker = linkMarker(slot);
  // The URL lands in an href and as text; it holds only URL-safe characters.
  if (!/^https?:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9/_-]*#t=[A-Za-z0-9_-]{43}$/.test(url)) {
    throw new TypeError("an access link URL is an origin, a path, and a token fragment");
  }
  return body.split(marker).join(url);
}
