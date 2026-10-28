import { bookingDayExportColumns, bookingDayExportGuestColumns } from "@tidegrid/contracts";
import { describe, expect, it } from "vitest";
import {
  csvField,
  csvInstant,
  csvMoney,
  csvText,
  dayExportFileName,
  renderCsv,
  renderDayExport,
} from "./csv.ts";
import { type DayReport, type DayReportRow, totalsOf } from "./day-report.ts";
import { emailFragment, escapeLike, nameWords, referencePrefix, searchFields } from "./search.ts";

/**
 * A minimal RFC 4180 reader, enough to read back what renderCsv writes. It
 * drops the byte order mark first, as a spreadsheet or `utf-8-sig` does.
 */
function parseCsv(withMark: string): string[][] {
  expect(withMark.startsWith("\ufeff")).toBe(true);
  const text = withMark.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  return rows;
}

/** A report row; net follows from total and refunds, as buildDayReport derives it. */
function row(over: Partial<Omit<DayReportRow, "net">> = {}): DayReportRow {
  const r = {
    bookingId: "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a11",
    reference: "QKG6ERBF",
    state: "confirmed",
    source: "direct",
    confirmedAt: "2026-10-06T18:17:00.123Z",
    trip: {
      tripId: "bc5f3492-d330-487d-8078-7221db331801",
      productName: "Sunset Harbor Cruise",
      productKind: "shared_seat",
      boatName: "Sea Lark",
      timeZone: "America/New_York",
      localDate: "2026-11-04",
      localStartTime: "18:00",
      startsAt: "2026-11-04T23:00:00.000Z",
    },
    bookings: 1,
    guests: 3,
    gross: 12500,
    discounts: 1250,
    fees: 750,
    taxes: 840,
    total: 12840,
    refunds: 0,
    includedTax: 0,
    paymentState: "succeeded",
    refundState: null,
    pendingRefund: { count: 0, amount: 0 },
    booker: { name: "Maya Okonkwo", email: "maya.okonkwo@guest.example" },
    ...over,
  } satisfies Omit<DayReportRow, "net">;
  return { ...r, net: r.total - r.refunds };
}

function report(rows: DayReportRow[]): DayReport {
  return {
    date: "2026-11-04",
    generatedAt: "2026-11-04T19:03:22.456Z",
    rows,
    totals: totalsOf(rows),
  };
}

describe("CSV fields", () => {
  it("quotes a field with a comma, a quote, or a line break, doubling quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("Okonkwo, Maya")).toBe('"Okonkwo, Maya"');
    expect(csvField('The "Lark"')).toBe('"The ""Lark"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("carriage\rreturn")).toBe('"carriage\rreturn"');
    expect(csvField("")).toBe("");
  });

  it.each([
    ['=HYPERLINK("http://x.example")', '\'=HYPERLINK("http://x.example")'],
    ["+1 555 0100", "'+1 555 0100"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tTabbed", "'\tTabbed"],
    ["\rReturn", "'\rReturn"],
  ])("keeps %j from running as a formula", (input, expected) => {
    expect(csvText(input)).toBe(expected);
  });

  it("leaves ordinary text and inner signs alone", () => {
    expect(csvText("Maya Okonkwo-Reyes")).toBe("Maya Okonkwo-Reyes");
    expect(csvText("José Núñez")).toBe("José Núñez");
    expect(csvText(" =not first")).toBe(" =not first");
  });

  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [99, "0.99"],
    [100, "1.00"],
    [12345, "123.45"],
    [100000000, "1000000.00"],
  ])("writes %i cents as %s", (cents, expected) => {
    expect(csvMoney(cents)).toBe(expected);
  });

  it("refuses money a column cannot hold", () => {
    expect(() => csvMoney(-1)).toThrow(RangeError);
    expect(() => csvMoney(1.5)).toThrow(RangeError);
    expect(() => csvMoney(Number.NaN)).toThrow(RangeError);
  });

  it("writes an instant as a UTC date and time a spreadsheet reads", () => {
    expect(csvInstant("2026-10-06T18:17:00.123Z")).toBe("2026-10-06 18:17:00");
    expect(csvInstant("2026-10-06T14:17:00-04:00")).toBe("2026-10-06 18:17:00");
  });

  it("starts the file with a byte order mark and ends every line with CRLF", () => {
    const csv = renderCsv(["A", "B"], [["1", "x,y"]]);
    expect(csv).toBe('\ufeffA,B\r\n1,"x,y"\r\n');
  });
});

describe("a day's export", () => {
  const maya = row();
  const luis = row({
    bookingId: "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a12",
    reference: "7HM2P9TW",
    confirmedAt: "2026-10-07T15:30:00.000Z",
    guests: 2,
    gross: 10000,
    discounts: 0,
    fees: 500,
    taxes: 700,
    total: 11200,
    refunds: 11200,
    refundState: "succeeded",
    source: "staff_assisted",
    booker: { name: "=cmd|' /C calc'!A0", email: "luis, fernandez@guest.example" },
  });
  const pending = row({
    bookingId: "3c1f6a52-9d44-4e0b-8a6f-2b7d5c9e0a13",
    reference: "3ZRB8N4C",
    guests: 6,
    gross: 120000,
    discounts: 0,
    fees: 0,
    taxes: 6500,
    total: 126500,
    includedTax: 300,
    refundState: "requested",
    pendingRefund: { count: 1, amount: 126500 },
    booker: { name: "Priya Raman", email: "priya.raman@guest.example" },
  });
  const day = report([maya, luis, pending]);

  it("sums every column into the control totals", () => {
    expect(day.totals).toEqual({
      bookings: 3,
      guests: 11,
      gross: 142500,
      discounts: 1250,
      fees: 1250,
      taxes: 8040,
      total: 150540,
      refunds: 11200,
      net: 139340,
      includedTax: 300,
      pendingRefunds: { count: 1, amount: 126500 },
    });
    // The identities the columns promise.
    const t = day.totals;
    expect(t.total).toBe(t.gross - t.discounts + t.fees + t.taxes);
    expect(t.net).toBe(t.total - t.refunds);
  });

  it("has stable columns, with the booker's only for roles that may see guests", () => {
    const staff = parseCsv(renderDayExport(day, { name: "Demo Harbor" }, { withBooker: true }));
    const finance = parseCsv(renderDayExport(day, { name: "Demo Harbor" }, { withBooker: false }));
    expect(staff[0]).toEqual([...bookingDayExportColumns, ...bookingDayExportGuestColumns]);
    expect(finance[0]).toEqual([...bookingDayExportColumns]);
    // Source was appended by G2.12d: after Generated at, before the booker's columns.
    expect(staff[0]?.slice(-3)).toEqual(["Source", "Booker name", "Booker email"]);
    expect(finance[0]?.at(-1)).toBe("Source");
    expect(staff[0]).toHaveLength(29);
    expect(finance[0]).toHaveLength(27);
    for (const rows of [staff, finance]) {
      for (const r of rows) expect(r).toHaveLength(rows[0]?.length ?? 0);
    }
  });

  it("gives finance no personal data at all", () => {
    const csv = renderDayExport(day, { name: "Demo Harbor" }, { withBooker: false });
    for (const fragment of ["Maya", "Okonkwo", "maya.okonkwo", "Priya", "Raman", "luis", "calc"]) {
      expect(csv).not.toContain(fragment);
    }
  });

  it("writes each booking's ledger and a total row equal to the control totals", () => {
    const rows = parseCsv(renderDayExport(day, { name: "Demo Harbor" }, { withBooker: true }));
    const header = rows[0] ?? [];
    const at = (r: string[] | undefined, column: string) => r?.[header.indexOf(column)];
    const first = rows[1];
    expect(at(first, "Row")).toBe("Booking");
    expect(at(first, "Operator")).toBe("Demo Harbor");
    expect(at(first, "Departure date")).toBe("2026-11-04");
    expect(at(first, "Departure time")).toBe("18:00");
    expect(at(first, "Time zone")).toBe("America/New_York");
    // The departure's exact instant beside its wall clock (review data F5).
    expect(at(first, "Departure at (UTC)")).toBe("2026-11-04 23:00:00");
    expect(at(first, "Booking reference")).toBe("QKG6ERBF");
    expect(at(first, "Pending refunds")).toBe("0.00");
    expect(at(first, "Gross")).toBe("125.00");
    expect(at(first, "Discounts")).toBe("12.50");
    expect(at(first, "Total")).toBe("128.40");
    expect(at(first, "Net")).toBe("128.40");
    expect(at(first, "Confirmed at (UTC)")).toBe("2026-10-06 18:17:00");
    expect(at(first, "Generated at (UTC)")).toBe("2026-11-04 19:03:22");
    expect(at(first, "Source")).toBe("direct");
    expect(at(rows[2], "Source")).toBe("staff_assisted");
    expect(at(first, "Booker name")).toBe("Maya Okonkwo");

    const total = rows.at(-1);
    expect(at(total, "Row")).toBe("Total");
    expect(at(total, "Bookings")).toBe("3");
    expect(at(total, "Guests")).toBe("11");
    expect(at(total, "Gross")).toBe("1425.00");
    expect(at(total, "Discounts")).toBe("12.50");
    expect(at(total, "Fees")).toBe("12.50");
    expect(at(total, "Added taxes")).toBe("80.40");
    expect(at(total, "Total")).toBe("1505.40");
    expect(at(total, "Refunds")).toBe("112.00");
    // Requested and unsettled: its own column, in neither Refunds nor Net (review UI-5).
    expect(at(total, "Pending refunds")).toBe("1265.00");
    expect(at(total, "Net")).toBe("1393.40");
    expect(at(total, "Included tax")).toBe("3.00");
    expect(at(total, "Time zone")).toBe("America/New_York");
    expect(at(total, "Departure at (UTC)")).toBe("");

    // Each money column of the total row is the sum of the booking rows.
    for (const column of [
      "Gross",
      "Discounts",
      "Fees",
      "Added taxes",
      "Total",
      "Refunds",
      "Pending refunds",
      "Net",
      "Included tax",
    ]) {
      const cents = rows
        .slice(1, -1)
        .map((r) => Math.round(Number(at(r, column)) * 100))
        .reduce((a, b) => a + b, 0);
      expect(Math.round(Number(at(total, column)) * 100)).toBe(cents);
    }
  });

  it("keeps a typed name from running as a formula and an email with a comma whole", () => {
    const rows = parseCsv(renderDayExport(day, { name: "Demo Harbor" }, { withBooker: true }));
    const header = rows[0] ?? [];
    const luisRow = rows.find((r) => r.includes("7HM2P9TW"));
    expect(luisRow?.[header.indexOf("Booker name")]).toBe("'=cmd|' /C calc'!A0");
    expect(luisRow?.[header.indexOf("Booker email")]).toBe("luis, fernandez@guest.example");
    expect(luisRow?.[header.indexOf("Refund state")]).toBe("succeeded");
  });

  it("neutralizes an operator's or trip's name that starts like a formula", () => {
    const odd = report([
      row({ trip: { ...maya.trip, productName: "@Sunset", boatName: "-Lark" } }),
    ]);
    const rows = parseCsv(renderDayExport(odd, { name: "=Harbor" }, { withBooker: false }));
    const header = rows[0] ?? [];
    expect(rows[1]?.[header.indexOf("Operator")]).toBe("'=Harbor");
    expect(rows[1]?.[header.indexOf("Trip")]).toBe("'@Sunset");
    expect(rows[1]?.[header.indexOf("Boat")]).toBe("'-Lark");
  });

  it("exports a day with no bookings as a header and a total row of zeros", () => {
    const rows = parseCsv(
      renderDayExport(report([]), { name: "Demo Harbor" }, { withBooker: true }),
    );
    expect(rows).toHaveLength(2);
    const header = rows[0] ?? [];
    expect(rows[1]?.[header.indexOf("Row")]).toBe("Total");
    expect(rows[1]?.[header.indexOf("Bookings")]).toBe("0");
    expect(rows[1]?.[header.indexOf("Net")]).toBe("0.00");
    expect(rows[1]?.[header.indexOf("Time zone")]).toBe("");
  });

  it("leaves the total row's zone blank when the day's trips are in two zones", () => {
    const honolulu = row({ trip: { ...maya.trip, timeZone: "Pacific/Honolulu" } });
    const rows = parseCsv(
      renderDayExport(report([maya, honolulu]), { name: "Demo Harbor" }, { withBooker: false }),
    );
    const header = rows[0] ?? [];
    expect(rows.at(-1)?.[header.indexOf("Time zone")]).toBe("");
  });

  it("names the file by operator and date only", () => {
    expect(dayExportFileName("demo-harbor", "2026-11-04")).toBe(
      "demo-harbor-bookings-2026-11-04.csv",
    );
  });
});

describe("reading a search's text", () => {
  it.each([
    ["QKG6ERBF", "QKG6ERBF"],
    ["qkg6-erbf", "QKG6ERBF"],
    ["qkg 6", "QKG6"],
    ["o1l", "011"],
    ["QK", "QK"],
  ])("reads %j as the reference prefix %j", (text, expected) => {
    expect(referencePrefix(text)).toBe(expected);
  });

  it.each(["Q", "Maya Okonkwo", "maya@guest.example", "QKG6ERBF1", "UUU", "50%"])(
    "reads %j as no reference",
    (text) => {
      expect(referencePrefix(text)).toBeNull();
    },
  );

  it("escapes LIKE's own characters", () => {
    expect(escapeLike("100%_off\\")).toBe("100\\%\\_off\\\\");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("splits a name into at most six words", () => {
    expect(nameWords("  Maya   Okonkwo ")).toEqual(["Maya", "Okonkwo"]);
    expect(nameWords("a b c d e f g h")).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("reads an email fragment only from text without spaces, in lowercase", () => {
    expect(emailFragment("Maya.Okonkwo@Guest")).toBe("maya.okonkwo@guest");
    expect(emailFragment("Maya Okonkwo")).toBeNull();
  });

  it("matches finance's text on references only", () => {
    expect(searchFields(false)).toEqual(["reference"]);
    expect(searchFields(true)).toEqual(["reference", "booker_name", "booker_email"]);
  });
});
