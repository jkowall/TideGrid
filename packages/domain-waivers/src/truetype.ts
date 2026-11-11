/**
 * Just enough TrueType for the waiver PDF to show names and typed
 * signatures outside WinAnsi: read a font's tables, find a character's glyph
 * and advance width, and write a copy that keeps only the glyphs a document
 * uses. `subsetTrueType` keeps glyph ids; `compactTrueType` renumbers the
 * kept glyphs from 1 and says which new id each old one got, so the PDF can
 * name glyphs by id (Identity-H with an identity CID-to-glyph map). Pure and
 * deterministic; runs in Workers and Node. The hinting programs (cvt, fpgm,
 * prep) are kept; no shaping or layout tables are: the alphabets the PDF
 * draws this way need none (see `fallback-ranges.ts`).
 */

export interface TrueTypeFont {
  bytes: Uint8Array;
  tables: ReadonlyMap<string, { offset: number; length: number }>;
  unitsPerEm: number;
  numGlyphs: number;
  /** Long (4-byte) offsets in `loca`. */
  longLoca: boolean;
  numberOfHMetrics: number;
  /** Unicode code point to glyph id, for the code points the font maps. */
  cmap: ReadonlyMap<number, number>;
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function table(font: { bytes: Uint8Array; tables: TrueTypeFont["tables"] }, tag: string) {
  const t = font.tables.get(tag);
  if (!t) throw new Error(`the font has no ${tag} table`);
  return { dv: new DataView(font.bytes.buffer, font.bytes.byteOffset + t.offset, t.length), ...t };
}

/** Read a TrueType (glyf-outline) font. Throws on anything else. */
export function parseTrueType(bytes: Uint8Array): TrueTypeFont {
  const dv = view(bytes);
  const version = dv.getUint32(0);
  if (version !== 0x00010000 && version !== 0x74727565) {
    throw new Error("not a TrueType font");
  }
  const count = dv.getUint16(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      dv.getUint8(at),
      dv.getUint8(at + 1),
      dv.getUint8(at + 2),
      dv.getUint8(at + 3),
    );
    tables.set(tag, { offset: dv.getUint32(at + 8), length: dv.getUint32(at + 12) });
  }
  const base = { bytes, tables };
  const head = table(base, "head").dv;
  const hhea = table(base, "hhea").dv;
  const maxp = table(base, "maxp").dv;
  return {
    bytes,
    tables,
    unitsPerEm: head.getUint16(18),
    longLoca: head.getInt16(50) === 1,
    bbox: [head.getInt16(36), head.getInt16(38), head.getInt16(40), head.getInt16(42)],
    ascent: hhea.getInt16(4),
    descent: hhea.getInt16(6),
    numberOfHMetrics: hhea.getUint16(34),
    numGlyphs: maxp.getUint16(4),
    // A subset made for one document has no cmap: the PDF names glyphs by id.
    cmap: tables.has("cmap") ? readCmap(base) : new Map(),
  };
}

/** The Unicode mapping, from a format 12 subtable when there is one, else format 4. */
function readCmap(font: { bytes: Uint8Array; tables: TrueTypeFont["tables"] }) {
  const { dv } = table(font, "cmap");
  const n = dv.getUint16(2);
  let format4: number | null = null;
  let format12: number | null = null;
  for (let i = 0; i < n; i++) {
    const platform = dv.getUint16(4 + i * 8);
    const encoding = dv.getUint16(6 + i * 8);
    const offset = dv.getUint32(8 + i * 8);
    const format = dv.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 ??= offset;
    if (format === 4) format4 ??= offset;
  }
  const map = new Map<number, number>();
  if (format12 !== null) {
    const groups = dv.getUint32(format12 + 12);
    for (let g = 0; g < groups; g++) {
      const at = format12 + 16 + g * 12;
      const start = dv.getUint32(at);
      const end = dv.getUint32(at + 4);
      const glyph = dv.getUint32(at + 8);
      for (let cp = start; cp <= end; cp++) map.set(cp, glyph + (cp - start));
    }
    return map;
  }
  if (format4 === null) throw new Error("the font has no Unicode cmap");
  const segX2 = dv.getUint16(format4 + 6);
  const ends = format4 + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s++) {
    const end = dv.getUint16(ends + s * 2);
    const start = dv.getUint16(starts + s * 2);
    const delta = dv.getInt16(deltas + s * 2);
    const rangeAt = rangeOffsets + s * 2;
    const rangeOffset = dv.getUint16(rangeAt);
    for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (cp + delta) & 0xffff;
      else {
        const raw = dv.getUint16(rangeAt + rangeOffset + (cp - start) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(cp, glyph);
    }
  }
  return map;
}

/** A glyph's advance width, in font units. */
export function advanceWidth(font: TrueTypeFont, glyph: number): number {
  const { dv } = table(font, "hmtx");
  const i = Math.min(glyph, font.numberOfHMetrics - 1);
  return dv.getUint16(i * 4);
}

function glyphRange(font: TrueTypeFont, glyph: number): [number, number] {
  const { dv } = table(font, "loca");
  if (font.longLoca) return [dv.getUint32(glyph * 4), dv.getUint32(glyph * 4 + 4)];
  return [dv.getUint16(glyph * 2) * 2, dv.getUint16(glyph * 2 + 2) * 2];
}

/** Whether a glyph has an outline (a space, or a glyph a reduced font dropped, has none). */
export function hasOutline(font: TrueTypeFont, glyph: number): boolean {
  if (glyph <= 0 || glyph >= font.numGlyphs) return false;
  const [from, to] = glyphRange(font, glyph);
  return to > from;
}

/** The glyphs a composite glyph is built from, in order; none for a simple glyph. */
export function components(font: TrueTypeFont, glyph: number): number[] {
  const [from, to] = glyphRange(font, glyph);
  if (to <= from) return [];
  const glyf = table(font, "glyf").dv;
  if (glyf.getInt16(from) >= 0) return [];
  const out: number[] = [];
  let at = from + 10;
  for (;;) {
    const flags = glyf.getUint16(at);
    out.push(glyf.getUint16(at + 2));
    at += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) at += 2;
    else if (flags & 0x0040) at += 4;
    else if (flags & 0x0080) at += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

/** The glyphs with every composite's parts, and .notdef. */
export function glyphClosure(font: TrueTypeFont, glyphs: Iterable<number>): Set<number> {
  const keep = new Set<number>([0]);
  const queue = [...glyphs];
  while (queue.length > 0) {
    const g = queue.pop() as number;
    if (g < 0 || g >= font.numGlyphs || keep.has(g)) continue;
    keep.add(g);
    queue.push(...components(font, g));
  }
  return keep;
}

const pad4 = (n: number) => (n + 3) & ~3;

function checksum(bytes: Uint8Array): number {
  const padded = new Uint8Array(pad4(bytes.length));
  padded.set(bytes);
  const dv = view(padded);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  return sum;
}

/** A name table with only the records whose ids are listed, Windows Unicode only. */
function nameSubset(font: TrueTypeFont, ids: ReadonlySet<number>): Uint8Array {
  const { dv } = table(font, "name");
  const count = dv.getUint16(2);
  const storage = dv.getUint16(4);
  const records: { ids: number[]; bytes: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const platform = dv.getUint16(at);
    const encoding = dv.getUint16(at + 2);
    const language = dv.getUint16(at + 4);
    const nameId = dv.getUint16(at + 6);
    if (platform !== 3 || encoding !== 1 || language !== 0x0409 || !ids.has(nameId)) continue;
    const length = dv.getUint16(at + 8);
    const offset = dv.getUint16(at + 10);
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + storage + offset, length).slice();
    records.push({ ids: [platform, encoding, language, nameId], bytes });
  }
  const header = 6 + records.length * 12;
  const total = header + records.reduce((n, r) => n + r.bytes.length, 0);
  const out = new Uint8Array(total);
  const o = view(out);
  o.setUint16(2, records.length);
  o.setUint16(4, header);
  let strings = 0;
  records.forEach((r, i) => {
    const at = 6 + i * 12;
    r.ids.forEach((v, j) => {
      o.setUint16(at + j * 2, v);
    });
    o.setUint16(at + 8, r.bytes.length);
    o.setUint16(at + 10, strings);
    out.set(r.bytes, header + strings);
    strings += r.bytes.length;
  });
  return out;
}

/** The copyright, family, style, full name, version, PostScript name, and license. */
const NOTICE_NAMES: ReadonlySet<number> = new Set([0, 1, 2, 4, 5, 6, 13, 14]);

/**
 * A copy of the font that keeps the outlines of `glyphs` (and the parts of
 * any composite among them) and empties every other glyph, so glyph ids stay
 * the same. `keep` names the extra tables to copy as they are; the copyright
 * and license names always come along, as the font's license asks.
 */
export function subsetTrueType(
  font: TrueTypeFont,
  glyphs: Iterable<number>,
  keep: readonly string[] = [],
): Uint8Array {
  const kept = glyphClosure(font, glyphs);
  const glyf = table(font, "glyf");
  const pieces: Uint8Array[] = [];
  const loca = new Uint8Array((font.numGlyphs + 1) * 4);
  const locaView = view(loca);
  let glyfLength = 0;
  for (let g = 0; g < font.numGlyphs; g++) {
    locaView.setUint32(g * 4, glyfLength);
    if (!kept.has(g)) continue;
    const [from, to] = glyphRange(font, g);
    if (to <= from) continue;
    const bytes = new Uint8Array(glyf.dv.buffer, glyf.dv.byteOffset + from, to - from);
    // Every glyph starts on a 4-byte boundary, as long offsets allow.
    const padded = new Uint8Array(pad4(bytes.length));
    padded.set(bytes);
    pieces.push(padded);
    glyfLength += padded.length;
  }
  locaView.setUint32(font.numGlyphs * 4, glyfLength);
  const glyfOut = new Uint8Array(glyfLength);
  let at = 0;
  for (const p of pieces) {
    glyfOut.set(p, at);
    at += p.length;
  }

  const copy = (tag: string) => {
    const t = table(font, tag);
    return new Uint8Array(t.dv.buffer, t.dv.byteOffset, t.length).slice();
  };
  const head = copy("head");
  const headView = view(head);
  headView.setUint32(8, 0); // checkSumAdjustment, set below
  headView.setInt16(50, 1); // long loca offsets

  const out = new Map<string, Uint8Array>([
    ["glyf", glyfOut],
    ["head", head],
    ["hhea", copy("hhea")],
    ["hmtx", copy("hmtx")],
    ["loca", loca],
    ["maxp", copy("maxp")],
    ["name", nameSubset(font, NOTICE_NAMES)],
  ]);
  for (const tag of ["cvt ", "fpgm", "prep", ...keep]) {
    if (font.tables.has(tag) && !out.has(tag)) out.set(tag, copy(tag));
  }
  return writeSfnt(out);
}

function writeSfnt(tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  const header = 12 + n * 16;
  const size = tags.reduce((s, t) => s + pad4((tables.get(t) as Uint8Array).length), header);
  const out = new Uint8Array(size);
  const dv = view(out);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, n);
  const power = 2 ** Math.floor(Math.log2(n));
  dv.setUint16(6, power * 16);
  dv.setUint16(8, Math.log2(power));
  dv.setUint16(10, n * 16 - power * 16);
  let offset = header;
  let headAt = 0;
  tags.forEach((tag, i) => {
    const bytes = tables.get(tag) as Uint8Array;
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c++) dv.setUint8(at + c, tag.charCodeAt(c));
    dv.setUint32(at + 4, checksum(bytes));
    dv.setUint32(at + 8, offset);
    dv.setUint32(at + 12, bytes.length);
    out.set(bytes, offset);
    if (tag === "head") headAt = offset;
    offset += pad4(bytes.length);
  });
  dv.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/**
 * A compact copy holding only `glyphs` (with .notdef first and the parts of
 * any composite), renumbered in order, for embedding in one document. Returns
 * the font and each original glyph's new id; composites point at their
 * parts' new ids.
 */
export function compactTrueType(
  font: TrueTypeFont,
  glyphs: Iterable<number>,
): { bytes: Uint8Array; glyphOf: ReadonlyMap<number, number> } {
  const order = [...glyphClosure(font, glyphs)].sort((a, b) => a - b);
  const glyphOf = new Map(order.map((g, i) => [g, i]));
  const glyf = table(font, "glyf");
  const pieces: Uint8Array[] = [];
  const loca = new Uint8Array((order.length + 1) * 4);
  const locaView = view(loca);
  const hmtx = new Uint8Array(order.length * 4);
  const hmtxView = view(hmtx);
  const metrics = table(font, "hmtx").dv;
  let glyfLength = 0;
  order.forEach((g, i) => {
    locaView.setUint32(i * 4, glyfLength);
    const metric = Math.min(g, font.numberOfHMetrics - 1);
    hmtxView.setUint16(i * 4, metrics.getUint16(metric * 4));
    const lsb =
      g < font.numberOfHMetrics
        ? metrics.getInt16(g * 4 + 2)
        : metrics.getInt16(font.numberOfHMetrics * 4 + (g - font.numberOfHMetrics) * 2);
    hmtxView.setInt16(i * 4 + 2, lsb);
    const [from, to] = glyphRange(font, g);
    if (to <= from) return;
    const padded = new Uint8Array(pad4(to - from));
    padded.set(new Uint8Array(glyf.dv.buffer, glyf.dv.byteOffset + from, to - from));
    const pv = view(padded);
    if (pv.getInt16(0) < 0) {
      // A composite: point each part at its new id.
      let at = 10;
      for (;;) {
        const flags = pv.getUint16(at);
        pv.setUint16(at + 2, glyphOf.get(pv.getUint16(at + 2)) ?? 0);
        at += 4 + (flags & 0x0001 ? 4 : 2);
        if (flags & 0x0008) at += 2;
        else if (flags & 0x0040) at += 4;
        else if (flags & 0x0080) at += 8;
        if (!(flags & 0x0020)) break;
      }
    }
    pieces.push(padded);
    glyfLength += padded.length;
  });
  locaView.setUint32(order.length * 4, glyfLength);
  const glyfOut = new Uint8Array(glyfLength);
  let at = 0;
  for (const p of pieces) {
    glyfOut.set(p, at);
    at += p.length;
  }
  const copy = (tag: string) => {
    const t = table(font, tag);
    return new Uint8Array(t.dv.buffer, t.dv.byteOffset, t.length).slice();
  };
  const head = copy("head");
  view(head).setUint32(8, 0);
  view(head).setInt16(50, 1);
  const hhea = copy("hhea");
  view(hhea).setUint16(34, order.length);
  const maxp = copy("maxp");
  view(maxp).setUint16(4, order.length);
  const out = new Map<string, Uint8Array>([
    ["glyf", glyfOut],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["name", nameSubset(font, NOTICE_NAMES)],
  ]);
  for (const tag of ["cvt ", "fpgm", "prep"]) {
    if (font.tables.has(tag)) out.set(tag, copy(tag));
  }
  return { bytes: writeSfnt(out), glyphOf };
}
