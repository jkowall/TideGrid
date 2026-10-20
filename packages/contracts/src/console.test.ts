import { describe, expect, it } from "vitest";
import {
  BookingNoteCreatedResponse,
  BookingNoteCreateRequest,
  bookingDayExportColumns,
} from "./console.ts";
import { bookingReferencePrefix, normalizeBookingReference } from "./references.ts";

describe("the start of a booking reference (G2.12c)", () => {
  it.each([
    ["QKG6ERBF", "QKG6ERBF"],
    ["qkg6-erbf", "QKG6ERBF"],
    ["qkg 6", "QKG6"],
    ["o1l", "011"],
    ["QK", "QK"],
  ])("reads %j as %j, as a whole reference is read", (text, expected) => {
    expect(bookingReferencePrefix(text)).toBe(expected);
  });

  it.each(["Q", "Maya Okonkwo", "maya@guest.example", "QKG6ERBF1", "UUU", "50%", "x".repeat(65)])(
    "reads %j as no reference",
    (text) => {
      expect(bookingReferencePrefix(text)).toBeNull();
    },
  );

  it("agrees with the whole-reference reader on every whole reference", () => {
    for (const typed of ["qkg6-erbf", " QKG6 ERBF ", "c03g4zfj", "o1l23456"]) {
      expect(bookingReferencePrefix(typed)).toBe(normalizeBookingReference(typed));
    }
  });
});

describe("a note's text (G2.12c)", () => {
  const ok = (body: string) => BookingNoteCreateRequest.safeParse({ body }).success;

  it("keeps line breaks and ordinary text, and trims the ends", () => {
    expect(ok("Guest called.\nTwo more may join.")).toBe(true);
    expect(BookingNoteCreateRequest.parse({ body: "  Cake on board.  " }).body).toBe(
      "Cake on board.",
    );
    expect(ok("👍")).toBe(true);
    expect(ok("José Núñez asked for a window seat")).toBe(true);
  });

  it.each([
    ["a C1 control", "a\u0090b"],
    ["next line (C1)", "\u0085"],
    ["delete", "a\u007fb"],
    ["a tab", "tab\there"],
    ["a bell", "bell\u0007"],
  ])("refuses %s", (_, body) => {
    expect(ok(body)).toBe(false);
  });

  it.each([
    ["a zero-width space", "\u200b"],
    ["a word joiner", "\u2060"],
    ["a byte order mark", "\ufeff"],
    ["a soft hyphen", "\u00ad"],
    ["a Hangul filler", "\u3164"],
    ["a variation selector", "\ufe0f"],
    ["only line breaks and spaces", " \n \n "],
  ])("refuses a note that is only %s", (_, body) => {
    expect(ok(body)).toBe(false);
  });

  it("counts 500 characters as code points after trimming, as the database does", () => {
    expect(ok(`${"y".repeat(500)}\n`)).toBe(true);
    expect(ok("😀".repeat(500))).toBe(true);
    expect(ok("😀".repeat(501))).toBe(false);
    expect(ok("y".repeat(501))).toBe(false);
  });

  it("answers an added note without its text, so the idempotent copy holds none", () => {
    const created = {
      id: "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a11",
      author: { userId: "5f0c3a52-2a55-4f8a-9d7e-5d6f0f1b2a01", name: "Olive Owner" },
      createdAt: "2026-10-06T18:17:00.000Z",
    };
    expect(BookingNoteCreatedResponse.safeParse({ note: created }).success).toBe(true);
    const parsed = BookingNoteCreatedResponse.parse({ note: { ...created, body: "Secret" } });
    expect(Object.keys(parsed.note)).not.toContain("body");
  });
});

describe("the day's export columns (G2.12c)", () => {
  it("carry the departure's instant and pending refunds, beside added and included taxes", () => {
    const at = (name: string) => bookingDayExportColumns.indexOf(name as never);
    expect(at("Departure at (UTC)")).toBe(at("Time zone") + 1);
    expect(at("Pending refunds")).toBe(at("Refunds") + 1);
    expect(at("Added taxes")).toBeGreaterThan(-1);
    expect(at("Included tax")).toBeGreaterThan(-1);
    expect(at("Taxes")).toBe(-1);
  });
});
