import { describe, expect, it } from "vitest";
import { readCsv } from "./csv-read.ts";
import { importContentHash, renderImportErrors } from "./dry-run.ts";
import { looksLikeCardNumber } from "./spec.ts";
import { type ImportLookup, MAX_ISSUES_KEPT, type TripInfo, validateImport } from "./validate.ts";
import { cachedZoneCount, isKnownZone } from "./zone-time.ts";

// The draft's synthetic batch (docs/v2/drafts/standard-csv-import.md), without
// the trip-card and dollar-card lots, which no operator can hold yet.
const P_REEF = "00000000-0000-4000-8000-000000000101";
const P_CHARTER = "00000000-0000-4000-8000-000000000102";
const B_REEF = "00000000-0000-4000-8000-000000000201";
const B_CHARTER = "00000000-0000-4000-8000-000000000202";

const lookup = (trips: TripInfo[] = []): ImportLookup => ({
  async products(ids) {
    const all = [
      {
        id: P_REEF,
        name: "Morning two-tank reef dive",
        kind: "shared_seat" as const,
        minParty: 1,
        maxParty: 12,
        seatLimit: 12,
        durationMinutes: 240,
        turnaroundMinutes: 30,
        zone: "America/New_York",
      },
      {
        id: P_CHARTER,
        name: "Half-day private charter",
        kind: "private_charter" as const,
        minParty: 1,
        maxParty: 6,
        seatLimit: null,
        durationMinutes: 240,
        turnaroundMinutes: 30,
        zone: "America/New_York",
      },
    ];
    return new Map(all.filter((p) => ids.includes(p.id)).map((p) => [p.id, p]));
  },
  async boats(ids) {
    const all = [
      { id: B_REEF, guestCapacity: 20, active: true, productIds: new Set([P_REEF]) },
      { id: B_CHARTER, guestCapacity: 6, active: true, productIds: new Set([P_CHARTER]) },
    ];
    return new Map(all.filter((b) => ids.includes(b.id)).map((b) => [b.id, b]));
  },
  async liveTrips() {
    return trips;
  },
  async zoneMismatches() {
    return new Set<number>();
  },
});

const NOW = Date.parse("2027-03-02T12:00:00Z");

function sample(): Record<string, string> {
  return {
    "manifest.csv": `item,file,value
batch_id,,DH-2027-03-A
run_number,,1
source_system,,legacy-booker
mapping_version,,std-csv-v0
batch_mode,,dry_run
operator_time_zone,,America/New_York
exported_at,,2027-03-01T17:00:00-05:00
waiver_notifications,,hold_until_staff_release
row_count,products.csv,2
row_count,trips.csv,3
sum_seat_capacity,trips.csv,24
row_count,customers.csv,4
rows_with_email,customers.csv,3
row_count,bookings.csv,4
sum_party_size,bookings.csv,13
rows_direct,bookings.csv,2
rows_staff_assisted,bookings.csv,1
rows_ota,bookings.csv,1
sum_total_cents,bookings.csv,206335
sum_included_tax_cents,bookings.csv,0
row_count,participants.csv,5
rows_minor,participants.csv,1
row_count,payments.csv,3
sum_payment_cents,payments.csv,117935
sum_refund_cents,payments.csv,0
sum_outstanding_cents,payments.csv,88400
row_count,opening_balances.csv,1
sum_booking_credit_cents,opening_balances.csv,5000
sum_dollar_card_cents,opening_balances.csv,0
sum_trip_count_units,opening_balances.csv,0
row_count,waivers.csv,4
rows_signed,waivers.csv,2
rows_unsigned,waivers.csv,1
rows_unknown,waivers.csv,1
`,
    "products.csv": `source_product_id,source_product_name,tidegrid_product_id,tidegrid_product_name,product_kind
P-REEF2,Two-tank reef dive,${P_REEF},Morning two-tank reef dive,shared_seat
P-CHARTER4,Half-day private charter,${P_CHARTER},Half-day private charter,private_charter
`,
    "trips.csv": `source_trip_id,source_product_id,tidegrid_boat_id,local_date,local_start_time,time_zone,utc_offset,seat_capacity
T-0412-AM,P-REEF2,${B_REEF},2027-04-12,08:00,America/New_York,,12
T-0412-PM,P-CHARTER4,${B_CHARTER},2027-04-12,13:00,America/New_York,,
T-0413-AM,P-REEF2,${B_REEF},2027-04-13,08:00,America/New_York,,12
`,
    "customers.csv": `source_customer_id,full_name,email,phone
C-1001,Avery Sample,avery.sample@example.test,
C-1002,Blake Synthetic,blake.synthetic@example.test,+15555550142
C-1003,Casey Placeholder,,
C-1004,Devon Fixture,devon.fixture@example.test,
`,
    "bookings.csv": `source_booking_ref,trip_date,source_trip_id,source_customer_id,booking_source,staff_channel,ota_channel,party_size,subtotal_cents,discount_cents,fee_cents,tax_cents,included_tax_cents,total_cents,balance_due_date,booked_at
LB-5001,2027-04-12,T-0412-AM,C-1001,direct,,,2,30000,0,1000,2100,0,33100,,2027-01-05T14:22:00-05:00
LB-5002,2027-04-12,T-0412-AM,C-1002,staff_assisted,phone,,3,45000,4500,1500,2835,0,44835,,2027-01-19T11:05:00-05:00
LB-5003,2027-04-12,T-0412-PM,C-1004,direct,,,6,120000,0,0,8400,0,128400,2027-04-05,2027-02-10T09:00:00-05:00
LB-5004,2027-04-13,T-0413-AM,C-1003,ota,,Example OTA,2,,,,,,,,2027-02-20T18:30:00-05:00
`,
    "participants.csv": `source_booking_ref,trip_date,position,full_name,is_minor,email,guardian_name,guardian_email
LB-5001,2027-04-12,1,Avery Sample,false,avery.sample@example.test,,
LB-5001,2027-04-12,2,Riley Sample,true,,Avery Sample,avery.sample@example.test
LB-5002,2027-04-12,1,Blake Synthetic,false,blake.synthetic@example.test,,
LB-5002,2027-04-12,2,Jordan Synthetic,false,,,
LB-5003,2027-04-12,1,Devon Fixture,false,devon.fixture@example.test,,
`,
    "payments.csv": `source_payment_id,source_booking_ref,trip_date,entry_kind,amount_cents,tender,reference,received_at
PAY-9001,LB-5001,2027-04-12,payment,33100,card_outside_tidegrid,LEGACY-AUTH-7781,2027-01-05T14:23:10-05:00
PAY-9002,LB-5002,2027-04-12,payment,44835,cash,,2027-02-25T10:00:00-05:00
PAY-9003,LB-5003,2027-04-12,payment,40000,check,CHK-1042,2027-02-10T09:05:00-05:00
`,
    "opening_balances.csv": `source_balance_id,source_customer_id,balance_kind,lot_kind,amount_cents,units,eligible_source_product_ids,expires_on,source_card_ref
OB-0001,C-1001,booking_credit,,5000,,,2027-12-31,
`,
    "waivers.csv": `source_booking_ref,trip_date,position,legacy_status,legacy_signed_on,legacy_system
LB-5001,2027-04-12,1,signed,2027-01-06,Example Waiver Tool
LB-5001,2027-04-12,2,signed,2027-01-06,Example Waiver Tool
LB-5002,2027-04-12,1,unsigned,,
LB-5003,2027-04-12,1,unknown,,
`,
  };
}

const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe("the standard CSV import's dry run (W3-G2.13)", () => {
  it("accepts the draft's sample batch, with every control total matching", async () => {
    const run = await validateImport(sample(), lookup(), NOW);
    expect(run.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(run.clean).toBe(true);
    expect(run.controls.every((c) => c.matches)).toBe(true);
    expect(run.controls).toContainEqual({
      file: "payments.csv",
      metric: "sum_outstanding_cents",
      declared: 88400,
      computed: 88400,
      matches: true,
    });
    // An adult without an email is a warning, not a refusal; so is what a
    // commit cannot save yet (a charter balance, opening balances, waivers).
    expect(run.issues).toEqual([
      expect.objectContaining({
        file: "bookings.csv",
        line: 4,
        code: "import_not_supported_yet",
        severity: "warning",
      }),
      expect.objectContaining({
        file: "participants.csv",
        line: 5,
        code: "participant_email_missing",
        severity: "warning",
        recordKey: "legacy-booker|LB-5002|2027-04-12|2",
      }),
      expect.objectContaining({
        file: "opening_balances.csv",
        line: null,
        code: "import_not_supported_yet",
        severity: "warning",
      }),
      expect.objectContaining({
        file: "waivers.csv",
        line: null,
        code: "import_not_supported_yet",
        severity: "warning",
      }),
    ]);
    expect(run.files.find((f) => f.file === "bookings.csv")).toEqual({
      file: "bookings.csv",
      rows: 4,
      accepted: 4,
      refused: 0,
    });
  });

  it("refuses rows by type, rule, and capacity, takes their children with them, and flags the totals", async () => {
    const files = sample();
    files["trips.csv"] = (files["trips.csv"] as string).replace(
      "2027-04-13,08:00",
      "2027-03-14,02:30",
    );
    files["bookings.csv"] =
      `${files["bookings.csv"]}LB-5010,2027-04-12,T-0412-AM,C-1001,direct,,,9,90000,0,0,0,0,90000,,
LB-5011,2027-04-12,T-0412-AM,C-1001,direct,,,1,100.00,0,0,0,0,100,,
LB-5012,2027-04-12,T-0412-PM,C-1002,direct,,,2,1000,0,0,0,0,1000,,
LB-5013,2027-04-12,T-0412-AM,C-1002,ota,,Example OTA,1,500,,,,,,,
`;
    files["payments.csv"] =
      `${files["payments.csv"]}PAY-9010,LB-5001,2027-04-12,payment,1,cash,4111 1111 1111 1111,2027-02-01T10:00:00-05:00
PAY-9011,LB-5010,2027-04-12,payment,90000,cash,,2027-02-01T10:00:00-05:00
PAY-9012,LB-5012,2027-04-12,payment,1000,cash,,2027-02-01T10:00:00-05:00
`;
    const run = await validateImport(files, lookup(), NOW);
    expect(run.clean).toBe(false);
    const at = (file: string, line: number) =>
      run.issues.filter((i) => i.file === file && i.line === line).map((i) => i.code);
    // 02:30 does not exist on the spring-forward night.
    expect(at("trips.csv", 4)).toEqual(["nonexistent_local_time"]);
    // The OTA booking on it, its participants, and its waivers go with it.
    expect(at("bookings.csv", 5)).toEqual(["parent_rejected"]);
    // 5 + 9 guests on 12 seats.
    expect(at("bookings.csv", 6)).toEqual(["over_capacity"]);
    // Dollars are refused, never guessed at.
    expect(at("bookings.csv", 7)).toContain("invalid_type");
    // A second booking of a private charter.
    expect(at("bookings.csv", 8)).toEqual(["charter_already_booked"]);
    expect(at("bookings.csv", 9)).toEqual(["ota_amounts_present"]);
    // A card number is never stored or shown.
    const card = run.issues.find((i) => i.code === "possible_card_number");
    expect(card).toMatchObject({
      file: "payments.csv",
      line: 5,
      column: "reference",
      value: "[withheld]",
    });
    expect(JSON.stringify(run.issues)).not.toContain("4111");
    // The declared totals no longer match the accepted rows.
    expect(codes(run)).toContain("control_total_mismatch");
    expect(
      run.controls.find((c) => c.file === "trips.csv" && c.metric === "row_count"),
    ).toMatchObject({
      declared: 3,
      computed: 2,
      matches: false,
    });
  });

  it("refuses a booking whose money does not balance before it takes seats, with its children", async () => {
    // LB-5002 pays 40000 of 44835: refused, and its participants, payment, and waiver go with it.
    const files = sample();
    files["payments.csv"] = (files["payments.csv"] as string).replace(
      "payment,44835,cash",
      "payment,40000,cash",
    );
    let run = await validateImport(files, lookup(), NOW);
    const at = (file: string, line: number) =>
      run.issues.filter((i) => i.file === file && i.line === line).map((i) => i.code);
    expect(at("bookings.csv", 3)).toEqual(["unexpected_balance"]);
    expect(at("participants.csv", 4)).toEqual(["parent_rejected"]);
    expect(at("participants.csv", 5)).toEqual(["parent_rejected"]);
    expect(at("payments.csv", 3)).toEqual(["parent_rejected"]);
    expect(at("waivers.csv", 4)).toEqual(["parent_rejected"]);
    expect(run.controls.find((c) => c.metric === "sum_payment_cents")?.computed).toBe(73100);

    // A refused booking's seats are free for the next: LB-5001 (10 guests) is
    // refused for its balance, so LB-5002's 3 fit.
    const big = sample();
    big["bookings.csv"] = (big["bookings.csv"] as string).replace(
      "LB-5001,2027-04-12,T-0412-AM,C-1001,direct,,,2,",
      "LB-5001,2027-04-12,T-0412-AM,C-1001,direct,,,10,",
    );
    big["payments.csv"] = (big["payments.csv"] as string).replace(
      "payment,33100,card",
      "payment,30000,card",
    );
    run = await validateImport(big, lookup(), NOW);
    expect(at("bookings.csv", 2)).toEqual(["unexpected_balance"]);
    expect(at("bookings.csv", 3)).toEqual([]);

    // A refund listed before its payment, and payment, payment, refund that nets
    // to the total, are both fine: the totals per booking decide, not the order.
    const ordered = sample();
    ordered["payments.csv"] = (ordered["payments.csv"] as string).replace(
      "PAY-9002,LB-5002,2027-04-12,payment,44835,cash,,2027-02-25T10:00:00-05:00",
      [
        "PAY-9002R,LB-5002,2027-04-12,refund,5000,cash,,2027-02-26T10:00:00-05:00",
        "PAY-9002,LB-5002,2027-04-12,payment,44835,cash,,2027-02-25T10:00:00-05:00",
        "PAY-9002B,LB-5002,2027-04-12,payment,5000,cash,,2027-02-25T11:00:00-05:00",
      ].join("\n"),
    );
    run = await validateImport(ordered, lookup(), NOW);
    expect(run.issues.filter((i) => i.file === "payments.csv").map((i) => i.code)).toEqual([]);

    // Refunds above payments refuse the refunds.
    const over = sample();
    over["payments.csv"] =
      `${over["payments.csv"]}PAY-9004,LB-5003,2027-04-12,refund,50000,check,,2027-02-11T09:05:00-05:00\n`;
    run = await validateImport(over, lookup(), NOW);
    expect(at("payments.csv", 5)).toEqual(["refund_exceeds_payments"]);
    // The booking goes too, and its other payment with it.
    expect(at("bookings.csv", 4)).toEqual(["refund_exceeds_payments"]);
    expect(at("payments.csv", 4)).toEqual(["parent_rejected"]);
  });

  it("refuses a trip the database's zone data reads differently, with its bookings", async () => {
    const disagreeing: ImportLookup = {
      ...lookup(),
      async zoneMismatches() {
        return new Set([0]);
      },
    };
    const run = await validateImport(sample(), disagreeing, NOW);
    const at = (file: string, line: number) =>
      run.issues.filter((i) => i.file === file && i.line === line).map((i) => i.code);
    expect(at("trips.csv", 2)).toEqual(["zone_mismatch"]);
    expect(at("bookings.csv", 2)).toEqual(["parent_rejected"]);
    expect(at("trips.csv", 3)).toEqual([]);
  });

  it("names a repeated manifest column, and checks the files past a bad control total", async () => {
    const files = sample();
    files["manifest.csv"] = (files["manifest.csv"] as string).replace(
      "item,file,value",
      "item,file,value,item",
    );
    let run = await validateImport(files, lookup(), NOW);
    expect(run.issues).toContainEqual(
      expect.objectContaining({ column: "item", code: "repeated_column" }),
    );

    const total = sample();
    total["manifest.csv"] = (total["manifest.csv"] as string).replace(
      "row_count,products.csv,2",
      "row_count,products.csv,2.0",
    );
    total["trips.csv"] = (total["trips.csv"] as string).replace("08:00", "8 am");
    run = await validateImport(total, lookup(), NOW);
    expect(run.manifest).not.toBeNull();
    expect(run.issues).toContainEqual(
      expect.objectContaining({ file: "manifest.csv", column: "value", code: "invalid_type" }),
    );
    expect(run.issues).toContainEqual(
      expect.objectContaining({ file: "trips.csv", column: "local_start_time" }),
    );
    expect(run.clean).toBe(false);
  });

  it("refuses a canceled departure and a card number in the manifest", async () => {
    const canceledTrip: TripInfo = {
      id: "00000000-0000-4000-8000-000000000302",
      productId: P_REEF,
      boatId: B_REEF,
      startsAtMs: Date.parse("2027-04-13T12:00:00Z"),
      boatFreeAtMs: Date.parse("2027-04-13T16:30:00Z"),
      seatCapacity: 12,
      salesState: "canceled",
      heldSeats: 0,
    };
    let run = await validateImport(sample(), lookup([canceledTrip]), NOW);
    expect(run.issues).toContainEqual(
      expect.objectContaining({ file: "trips.csv", line: 4, code: "trip_canceled" }),
    );
    expect(run.issues.filter((i) => i.code === "boat_overlap")).toEqual([]);

    const files = sample();
    files["manifest.csv"] = (files["manifest.csv"] as string).replace(
      "batch_id,,DH-2027-03-A",
      "batch_id,,4242424242424242",
    );
    run = await validateImport(files, lookup(), NOW);
    expect(run.manifest).toBeNull();
    expect(run.issues).toContainEqual(
      expect.objectContaining({ column: "batch_id", code: "possible_card_number" }),
    );
    const header = sample();
    header["manifest.csv"] = (header["manifest.csv"] as string).replace(
      "item,file,value",
      "item,file,value,4111111111111111",
    );
    const bad = await validateImport(header, lookup(), NOW);
    expect(bad.issues).toContainEqual(
      expect.objectContaining({ column: "column 4", code: "unknown_column" }),
    );
    expect(JSON.stringify([run, bad])).not.toMatch(/4242424242424242|4111111111111111/);
  });

  it("refuses an unknown column, a commit, a past trip, and a busy boat", async () => {
    const files = sample();
    files["customers.csv"] = (files["customers.csv"] as string).replace(
      "full_name,email,phone",
      "full_name,email,phone,medical_notes",
    );
    let run = await validateImport(files, lookup(), NOW);
    expect(run.issues).toContainEqual(
      expect.objectContaining({
        file: "customers.csv",
        code: "unknown_column",
        column: "column 5",
      }),
    );
    expect(JSON.stringify(run)).not.toContain("medical_notes");

    const commit = sample();
    commit["manifest.csv"] = (commit["manifest.csv"] as string).replace(
      "batch_mode,,dry_run",
      "batch_mode,,commit",
    );
    run = await validateImport(commit, lookup(), NOW);
    expect(run.manifest).toBeNull();
    expect(codes(run)).toEqual(["batch_mode_not_supported"]);

    // The check runs after the first trip has left.
    run = await validateImport(sample(), lookup(), Date.parse("2027-04-12T13:00:00Z"));
    expect(run.issues).toContainEqual(
      expect.objectContaining({ file: "trips.csv", line: 2, code: "trip_departed" }),
    );

    // Another trip already has the reef boat at 09:00 on April 13.
    const busy: TripInfo = {
      id: "00000000-0000-4000-8000-000000000301",
      productId: P_REEF,
      boatId: B_REEF,
      startsAtMs: Date.parse("2027-04-13T13:00:00Z"),
      boatFreeAtMs: Date.parse("2027-04-13T17:30:00Z"),
      seatCapacity: 12,
      salesState: "published",
      heldSeats: 0,
    };
    run = await validateImport(sample(), lookup([busy]), NOW);
    expect(run.issues).toContainEqual(
      expect.objectContaining({ file: "trips.csv", line: 4, code: "boat_overlap" }),
    );

    // The same departure already in TideGrid takes the import's seats on top of its own.
    const existing: TripInfo = {
      ...busy,
      startsAtMs: Date.parse("2027-04-12T12:00:00Z"),
      boatFreeAtMs: Date.parse("2027-04-12T16:30:00Z"),
      heldSeats: 8,
    };
    run = await validateImport(sample(), lookup([existing]), NOW);
    expect(run.issues).toContainEqual(
      expect.objectContaining({ file: "bookings.csv", line: 3, code: "over_capacity" }),
    );
  });

  it("never repeats a card number, in a key, a value, or a list of ids", async () => {
    const card = "4242424242424242";
    const files = sample();
    files["payments.csv"] = (files["payments.csv"] as string)
      .replace("PAY-9002", card)
      .replace("payment,40000,check", "payment,4012888888881881,check");
    files["opening_balances.csv"] = (files["opening_balances.csv"] as string).replace(
      "booking_credit,,5000,,,",
      `booking_credit,,5000,,P-REEF2|4111 1111 1111 1111,`,
    );
    const run = await validateImport(files, lookup(), NOW);
    expect(run.issues).toContainEqual(
      expect.objectContaining({
        file: "payments.csv",
        line: 3,
        code: "possible_card_number",
        recordKey: null,
      }),
    );
    expect(run.issues).toContainEqual(
      expect.objectContaining({
        file: "opening_balances.csv",
        column: "eligible_source_product_ids",
        code: "possible_card_number",
        value: "[withheld]",
      }),
    );
    const text = JSON.stringify(run) + renderImportErrors(run);
    expect(text).not.toContain(card);
    expect(text).not.toContain("4111 1111 1111 1111");
    expect(text).not.toContain("4012888888881881");
    expect(run.issues).toContainEqual(
      expect.objectContaining({
        file: "payments.csv",
        column: "amount_cents",
        value: "[withheld]",
      }),
    );
  });

  it("keeps at most a fixed number of issues and short messages, but counts them all", async () => {
    const files = sample();
    const header = "source_customer_id,full_name,email,phone";
    const rows = Array.from({ length: 6_000 }, () => "C-DUP,Same Person,,");
    files["customers.csv"] = `${header}\n${rows.join("\n")}\n`;
    const run = await validateImport(files, lookup(), NOW);
    expect(run.issues.length).toBe(MAX_ISSUES_KEPT);
    expect(run.issuesCapped).toBe(true);
    expect(run.errorCount + run.warningCount).toBeGreaterThan(MAX_ISSUES_KEPT);
    const dup = run.issues.find((i) => i.code === "duplicate_key_in_batch");
    expect(dup?.message).toMatch(/lines 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, and 5990 more/);
    expect(run.issues.every((i) => (i.value ?? "").length <= 67)).toBe(true);
  });

  it("finds two new trips on one boat at once, however the file orders them", async () => {
    const files = sample();
    files["trips.csv"] =
      `${files["trips.csv"]}T-0413-LATE,P-REEF2,${B_REEF},2027-04-13,10:00,America/New_York,,12\n`;
    const run = await validateImport(files, lookup(), NOW);
    const overlaps = run.issues.filter((i) => i.code === "boat_overlap").map((i) => i.line);
    expect(overlaps.sort()).toEqual([4, 5]);
  });

  it("knows zones without letting spellings grow its cache", () => {
    expect(isKnownZone("America/New_York")).toBe(true);
    expect(isKnownZone("Etc/UTC")).toBe(false);
    expect(isKnownZone("Not/A_Zone")).toBe(false);
    const name = "america/new_york";
    for (let i = 0; i < 2_000; i += 1) {
      const spelled = [...name].map((ch, j) => ((i >> j) & 1 ? ch.toUpperCase() : ch)).join("");
      isKnownZone(spelled);
    }
    expect(cachedZoneCount()).toBeLessThanOrEqual(600);
  });

  it("writes errors.csv with every cell kept from running as a formula", async () => {
    const files = sample();
    files["products.csv"] = (files["products.csv"] as string).replace(
      "P-REEF2,Two-tank reef dive",
      "P-REEF2,=HYPERLINK(1)",
    );
    files["manifest.csv"] = (files["manifest.csv"] as string).replace(
      "row_count,products.csv,2",
      "row_count,products.csv,-3",
    );
    const run = await validateImport(files, lookup(), NOW);
    const csv = renderImportErrors(run);
    const parsed = readCsv(csv);
    if (!parsed.ok) throw new Error("errors.csv did not parse");
    expect(parsed.header).toEqual([
      "batch_id",
      "run_number",
      "file",
      "line",
      "record_key",
      "column",
      "code",
      "severity",
      "message",
      "value",
    ]);
    const mismatch = parsed.records.find((r) => r.fields[6] === "control_total_mismatch");
    expect(mismatch?.fields[9]).toBe("'-3");
    expect(csv).not.toContain(",=");
  });

  it("hashes a batch the same across its dry runs, and differently when a file changes", async () => {
    const first = sample();
    const second = sample();
    second["manifest.csv"] = (second["manifest.csv"] as string).replace(
      "run_number,,1",
      "run_number,,2",
    );
    expect(await importContentHash(first)).toBe(await importContentHash(second));
    second["customers.csv"] = (second["customers.csv"] as string).replace("Avery", "Avory");
    expect(await importContentHash(first)).not.toBe(await importContentHash(second));
  });

  it("reads RFC 4180 quoting and counts records, not lines", () => {
    const parsed = readCsv('﻿a,b\r\n"x, ""y""","line\nbreak"\r\nz,w\n');
    expect(parsed).toEqual({
      ok: true,
      header: ["a", "b"],
      records: [
        { line: 2, fields: ['x, "y"', "line\nbreak"] },
        { line: 3, fields: ["z", "w"] },
      ],
    });
    expect(readCsv('a\n"open')).toEqual({ ok: false, reason: "unterminated_quote" });
    expect(looksLikeCardNumber("4111-1111-1111-1111")).toBe(true);
    expect(looksLikeCardNumber("4111111111111112")).toBe(false);
  });
});
