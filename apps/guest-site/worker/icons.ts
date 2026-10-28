import { type PublicBrand, primaryInk, svgLogoProblem } from "@tidegrid/contracts";

/**
 * The tenant's app icons (G2.14b, D3(a), a coordinator default pending owner
 * confirmation). One build serves every tenant, so the Worker composes each
 * icon from the published brand: a square of the brand's primary color with
 * the brand's validated SVG mark centered on it. The composed document goes
 * back through the logo validator before it is served. A brand with no logo,
 * a lockup (too wide for a square), a PNG or WebP mark (which an SVG could
 * show only through a data URI the validator refuses), or a mark the
 * composition cannot place gets a neutral platform mark on the primary.
 *
 * The icons have no approved asset hash in the tenant manifest; the demo
 * build plan records that narrowing.
 */

export const ICON_SIZE = 512;
export type IconPurpose = "any" | "maskable";

/** How much of the square the mark takes: maskable icons keep it inside the safe zone. */
const markShare: Record<IconPurpose, number> = { any: 0.72, maskable: 0.56 };

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodeSvgDataUri(src: string): string | null {
  const prefix = "data:image/svg+xml;base64,";
  if (!src.startsWith(prefix)) return null;
  try {
    const binary = atob(src.slice(prefix.length));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

const number = String.raw`(\d+(?:\.\d+)?)`;

/** The mark as a child element, with its own width and height, or null when it cannot be placed. */
function placeableMark(svg: string): { body: string; width: number; height: number } | null {
  const body = svg.replace(/^﻿?<\?xml[^>]*\?>\s*/, "").trim();
  const open = /^<svg\b[^>]*>/.exec(body)?.[0];
  if (!open || !body.endsWith("</svg>")) return null;
  // The xlink namespace may be declared on the root only, which this mark no longer is.
  if (open.includes("xmlns:xlink")) return null;
  const width = Number(new RegExp(String.raw`\swidth="${number}"`).exec(open)?.[1]);
  const height = Number(new RegExp(String.raw`\sheight="${number}"`).exec(open)?.[1]);
  if (!(width > 0 && height > 0)) return null;
  return { body, width, height };
}

function frame(brand: PublicBrand, inner: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" width="${ICON_SIZE}" height="${ICON_SIZE}">`,
    `<title>${escapeText(brand.name)}</title>`,
    `<rect width="${ICON_SIZE}" height="${ICON_SIZE}" fill="${brand.colors.primary}"/>`,
    inner,
    "</svg>",
  ].join("");
}

/** The neutral platform mark: three waves in the ink that reads on the primary. */
export function neutralIcon(brand: PublicBrand, purpose: IconPurpose): string {
  const ink = primaryInk(brand.colors.primary);
  const s = (markShare[purpose] * ICON_SIZE) / 64;
  const t = (ICON_SIZE - 64 * s) / 2;
  const wave = (y: number) =>
    `<path d="M8 ${y}c6 0 6-5 12-5s6 5 12 5 6-5 12-5 6 5 12 5" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`;
  return frame(
    brand,
    `<g transform="translate(${t.toFixed(2)} ${t.toFixed(2)}) scale(${s.toFixed(4)})">${wave(22)}${wave(34)}${wave(46)}</g>`,
  );
}

/** The tenant's icon: its mark on its primary, or the neutral mark. Always passes the logo validator. */
export function tenantIcon(brand: PublicBrand, purpose: IconPurpose): string {
  const logo = brand.logo;
  const svg = logo?.kind === "mark" ? decodeSvgDataUri(logo.src) : null;
  const mark = svg ? placeableMark(svg) : null;
  if (mark) {
    const s = (markShare[purpose] * ICON_SIZE) / Math.max(mark.width, mark.height);
    const tx = (ICON_SIZE - mark.width * s) / 2;
    const ty = (ICON_SIZE - mark.height * s) / 2;
    const composed = frame(
      brand,
      `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">${mark.body}</g>`,
    );
    if (svgLogoProblem(composed) === null) return composed;
  }
  return neutralIcon(brand, purpose);
}
