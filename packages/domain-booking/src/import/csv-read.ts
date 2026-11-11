/**
 * Reading a standard import file (W3-G2.13): RFC 4180 records, comma
 * separated, CRLF or LF line ends, an optional UTF-8 byte order mark. Pure;
 * runs in Workers and Node.
 *
 * Each record keeps its record number, counting the header as 1, so an error
 * points at the same row a spreadsheet shows when no field holds a line break.
 */

export interface CsvRecord {
  /** The record number, the header being 1. */
  line: number;
  fields: string[];
}

export type CsvReadResult =
  | { ok: true; header: string[]; records: CsvRecord[] }
  | { ok: false; reason: "empty" | "unterminated_quote" | "stray_quote" };

/** Reads every record; a blank last line is not a record. */
export function readCsv(text: string): CsvReadResult {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        // After a closing quote only a separator or a line end may follow.
        const next = body[i];
        if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") {
          return { ok: false, reason: "stray_quote" };
        }
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) return { ok: false, reason: "stray_quote" };
      quoted = true;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
      i += ch === "\r" && body[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
  }
  if (quoted) return { ok: false, reason: "unterminated_quote" };
  if (fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...rest] = rows;
  if (!header || (header.length === 1 && header[0] === "")) return { ok: false, reason: "empty" };
  const records: CsvRecord[] = [];
  rest.forEach((fields, index) => {
    // A line with nothing on it is not a record.
    if (fields.length === 1 && fields[0] === "") return;
    records.push({ line: index + 2, fields });
  });
  return { ok: true, header: header.map((h) => h.trim()), records };
}
