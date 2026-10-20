// The guest is in Tokyo and the marina in New York: no rule or word here may follow the host zone.
process.env.TZ = "Asia/Tokyo";

import {
  AccessToken,
  CancellationTerms,
  ManagedBooking,
  ManagedBookingResponse,
  Participant,
  ParticipantInput,
} from "@tidegrid/contracts";
import type { LedgerRow } from "@tidegrid/design-system/components";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testNow } from "../booking/fixtures.ts";
import {
  ava,
  canceledBooking,
  cutoffAt,
  departsAt,
  linkToken,
  managedBooking,
  orderLines,
  orderTotals,
  paid,
  sessionToken,
  terms,
  theo,
  withTerms,
} from "./fixtures.ts";
import {
  cutoffSentence,
  formErrors,
  formOf,
  inputOf,
  type LinkProblem,
  linkProblemCopy,
  linkProblemOf,
  namedText,
  orderRows,
  type ParticipantForm,
  participantDetail,
  refundSentence,
  refundStateText,
  slotsOf,
} from "./model.ts";

/** U+00A0, which joins a time to AM or PM. */
const nbsp = String.fromCharCode(0x00a0);
/** U+2212, which the money formatter uses for a negative amount. */
const minus = String.fromCharCode(0x2212);
/** U+2014, which no copy may use. */
const emDash = String.fromCharCode(0x2014);

const operator = "Demo Harbor Charters";

afterEach(() => {
  vi.useRealTimers();
});

// The fixtures ------------------------------------------------------------------------------

describe("the fixtures", () => {
  it("shape the booking exactly as the contract says", () => {
    expect(ManagedBooking.parse(managedBooking())).toEqual(managedBooking());
    expect(
      ManagedBooking.parse(managedBooking({ participants: { partySize: 3, participants: [] } })),
    ).toBeTruthy();
  });

  it.each(["full_refund", "percent_refund", "none", "credit"] as const)(
    "shape what canceling gives under %s as the contract says",
    (remedy) => {
      const shaped = terms(remedy);
      expect(CancellationTerms.parse(shaped)).toEqual(shaped);
      expect(ManagedBooking.parse(withTerms(managedBooking(), shaped)).cancellationTerms).toEqual(
        shaped,
      );
    },
  );

  it.each(["full_refund", "percent_refund", "none"] as const)(
    "shape a booking canceled under %s as the contract says",
    (remedy) => {
      const canceled = canceledBooking(withTerms(managedBooking(), terms(remedy)));
      expect(ManagedBooking.parse(canceled)).toEqual(canceled);
      expect(canceled.state).toBe("canceled");
      expect(canceled.cancellation?.remedy).toBe(remedy);
      expect(canceled.partyEditable).toBe(false);
      expect(canceled.cancellationTerms).toMatchObject({
        cancelable: false,
        refusal: "already_canceled",
      });
      // No refund is asked for when the policy gives none back.
      expect(canceled.refund === null).toBe(remedy === "none");
    },
  );

  it("shape the API's answers, the guests, and the tokens as the contract says", () => {
    const answer = { booking: managedBooking(), session: { expiresAt: testNow.toISOString() } };
    expect(ManagedBookingResponse.parse(answer)).toEqual(answer);
    for (const guest of [ava, theo]) expect(Participant.parse(guest)).toEqual(guest);
    expect(AccessToken.safeParse(linkToken).success).toBe(true);
    expect(AccessToken.safeParse(sessionToken).success).toBe(true);
    expect(linkToken).not.toBe(sessionToken);
  });

  it("add up: the lines make the totals, and the totals make the total paid", () => {
    const sum = (kinds: string[]) =>
      orderLines.filter((l) => kinds.includes(l.kind)).reduce((n, l) => n + l.amount, 0);
    expect(sum(["service", "add_on"])).toBe(orderTotals.subtotal);
    expect(sum(["fee"])).toBe(orderTotals.fees);
    expect(sum(["tax"])).toBe(orderTotals.tax);
    expect(orderTotals.subtotal - orderTotals.discount + orderTotals.fees + orderTotals.tax).toBe(
      orderTotals.total,
    );
    expect(orderTotals.total).toBe(paid);
    expect(managedBooking().payment.amount).toBe(paid);
  });

  it("round half up, to the cent, when the policy gives back part", () => {
    const half = terms("percent_refund");
    expect((paid * half.refundBp) / 10_000).toBe(8025.5);
    expect(half.refundAmount).toBe(8026);
    expect(half.refundAmount).toBe(Math.round((paid * half.refundBp) / 10_000));
  });

  it("put the policy's cutoff a day before the departure", () => {
    expect(Date.parse(departsAt) - Date.parse(cutoffAt)).toBe(24 * 60 * 60_000);
  });
});

// A link that does not open ---------------------------------------------------------------------

describe("linkProblemOf", () => {
  it.each([
    ["link_used", "used"],
    ["link_expired", "expired"],
    ["link_superseded", "superseded"],
    ["link_revoked", "revoked"],
    ["link_not_found", "not_found"],
  ] as const)("reads the API's %s as %s", (code, problem) => {
    expect(linkProblemOf(code)).toBe(problem);
  });

  it.each([
    "",
    "unknown",
    "rate_limited",
    "session_expired",
    "session_required",
    "invalid_request",
    "internal_error",
    "link_unknown",
    "LINK_USED",
    "link_used ",
    " link_used",
    "used",
    "not_found",
  ])("reads %j as no link problem", (code) => {
    expect(linkProblemOf(code)).toBeNull();
  });
});

describe("linkProblemCopy", () => {
  const problems: LinkProblem[] = ["used", "expired", "superseded", "revoked", "not_found"];

  it("words each problem as its own screen", () => {
    expect(linkProblemCopy("used", operator)).toEqual({
      title: "This link was already used",
      body: "Each link opens your booking once, so it stays yours if the email is forwarded. Ask for a new one and we'll email it to the address you booked with.",
    });
    expect(linkProblemCopy("expired", operator)).toEqual({
      title: "This link has expired",
      body: "Links work for three days. Ask for a new one and we'll email it to the address you booked with.",
    });
    expect(linkProblemCopy("superseded", operator)).toEqual({
      title: "A newer email replaced this link",
      body: "Use the link in your most recent email from us, or ask for a new one.",
    });
    expect(linkProblemCopy("revoked", operator)).toEqual({
      title: "This link no longer works",
      body: "Ask for a new one and we'll email it to the address you booked with.",
    });
    expect(linkProblemCopy("not_found", operator)).toEqual({
      title: "This link doesn't open a booking here",
      body: "Check that you opened the whole link from your email. If it still doesn't work, contact Demo Harbor Charters.",
    });
  });

  it("gives each problem its own title", () => {
    const titles = problems.map((p) => linkProblemCopy(p, operator).title);
    expect(new Set(titles).size).toBe(problems.length);
  });

  it("names the operator only where the guest has to reach them, and says whichever operator it is given", () => {
    for (const problem of problems) {
      const { title, body } = linkProblemCopy(problem, operator);
      expect(title).not.toContain(operator);
      expect(body.includes(operator)).toBe(problem === "not_found");
    }
    expect(linkProblemCopy("not_found", "Blue Heron Tours").body).toContain("Blue Heron Tours");
    expect(linkProblemCopy("not_found", "Blue Heron Tours").body).not.toContain(operator);
  });

  it("offers a new link for every problem but a link that names no booking here", () => {
    for (const problem of problems) {
      const { body } = linkProblemCopy(problem, operator);
      expect(/ask for a new one/i.test(body)).toBe(problem !== "not_found");
    }
  });

  it("says what happened in plain words: no status, no code, no dash", () => {
    for (const problem of problems) {
      const { title, body } = linkProblemCopy(problem, operator);
      expect(`${title} ${body}`).not.toMatch(/\b[1-5]\d\d\b|link_|_/);
      expect(`${title} ${body}`).not.toContain(emDash);
    }
  });
});

// The party ---------------------------------------------------------------------------------

describe("slotsOf", () => {
  it("gives one place for each guest in the party, with the participant who holds it", () => {
    expect(slotsOf(3, [ava, theo])).toEqual([
      { position: 1, participant: ava },
      { position: 2, participant: theo },
      { position: 3, participant: null },
    ]);
  });

  it("leaves a place empty whichever places are named, whatever order they come in", () => {
    expect(slotsOf(3, [theo])).toEqual([
      { position: 1, participant: null },
      { position: 2, participant: theo },
      { position: 3, participant: null },
    ]);
    expect(slotsOf(2, [theo, ava])).toEqual([
      { position: 1, participant: ava },
      { position: 2, participant: theo },
    ]);
  });

  it("has every place empty before anyone is named, and one place for a party of one", () => {
    expect(slotsOf(2, [])).toEqual([
      { position: 1, participant: null },
      { position: 2, participant: null },
    ]);
    expect(slotsOf(1, [])).toEqual([{ position: 1, participant: null }]);
  });

  it("numbers the places from 1 and does not change what it is given", () => {
    const named = [theo, ava];
    const before = structuredClone(named);
    expect(slotsOf(4, named).map((s) => s.position)).toEqual([1, 2, 3, 4]);
    expect(named).toEqual(before);
  });
});

describe("namedText", () => {
  it("says how many of the party are named", () => {
    expect(namedText(3, [ava, theo])).toBe("2 of 3 named");
    expect(namedText(3, [])).toBe("0 of 3 named");
    expect(namedText(1, [ava])).toBe("1 of 1 named");
    expect(namedText(12, [ava, theo])).toBe("2 of 12 named");
  });
});

describe("participantDetail", () => {
  it("names the guardian of a minor", () => {
    expect(participantDetail(theo)).toBe("Under 18. Guardian: Ava Guest");
  });

  it("shows an adult's own email when they gave one, and says Adult when they did not", () => {
    expect(participantDetail({ ...ava, email: "ava@example.test" })).toBe("ava@example.test");
    expect(participantDetail(ava)).toBe("Adult");
  });

  it("shows the guardian, not the minor's own email", () => {
    expect(participantDetail({ ...theo, email: "theo@example.test" })).toBe(
      "Under 18. Guardian: Ava Guest",
    );
  });
});

// The receipt -------------------------------------------------------------------------------

/** A row as a Ledger reads it: a row with no kind is an item. */
const asRead = (rows: LedgerRow[]) => rows.map((row) => ({ ...row, kind: row.kind ?? "item" }));

describe("orderRows", () => {
  const order = (
    lines = orderLines,
    totals: Partial<ManagedBooking["order"]["totals"]> = {},
  ): ManagedBooking["order"] => ({
    ...managedBooking().order,
    lines,
    totals: { ...orderTotals, ...totals },
  });

  it("lists the trip price, extras, fees, and taxes as the order holds them, then the total paid", () => {
    expect(asRead(orderRows(order()))).toEqual([
      { id: "l1", label: "Adult", detail: "2 × $45.00", amount: "$90.00", kind: "item" },
      {
        id: "l2",
        label: "Child (3 to 12)",
        detail: "1 × $25.00",
        amount: "$25.00",
        kind: "item",
      },
      { id: "l3", label: "Souvenir photo", detail: "1 × $12.00", amount: "$12.00", kind: "item" },
      { id: "l4", label: "Drink voucher", detail: "2 × $8.00", amount: "$16.00", kind: "item" },
      { id: "l5", label: "Harbor fee", detail: "3 × $2.50", amount: "$7.50", kind: "item" },
      { id: "l6", label: "County surtax", detail: "1%", amount: "$1.43", kind: "item" },
      { id: "l7", label: "State sales tax", detail: "6%", amount: "$8.58", kind: "item" },
      { id: "total", label: "Total paid", amount: "$160.51", kind: "total" },
    ]);
  });

  it("gives the total paid the total's kind, and no detail", () => {
    const rows = orderRows(order());
    expect(rows.at(-1)).toEqual({
      id: "total",
      label: "Total paid",
      amount: "$160.51",
      kind: "total",
    });
    expect(rows.at(-1)).not.toHaveProperty("detail");
  });

  it("leaves a tax that is inside the prices out of the items, and notes it after the total", () => {
    const levy = {
      ...orderLines[0],
      lineNo: 8,
      kind: "tax" as const,
      code: "harbor_levy",
      name: "Harbor levy",
      basis: null,
      quantity: 1,
      unitAmount: 542,
      amount: 542,
      taxInclusive: true,
      taxRatePpm: 47_120,
    };
    const rows = orderRows(order([...orderLines, levy], { includedTax: 542 }));
    const labels = rows.map((r) => r.label);
    // Not an item: the total is not the sum of it.
    expect(labels).not.toContain("Harbor levy");
    expect(rows.map((r) => r.id)).not.toContain("l8");
    expect(asRead(rows).slice(-3)).toEqual([
      { id: "l7", label: "State sales tax", detail: "6%", amount: "$8.58", kind: "item" },
      { id: "total", label: "Total paid", amount: "$160.51", kind: "total" },
      { id: "included", label: "Taxes included in the prices", amount: "$5.42", kind: "note" },
    ]);
  });

  it("notes the included tax once, as the sum the order reports, however many taxes are included", () => {
    const included = (lineNo: number, name: string, amount: number) => ({
      ...orderLines[0],
      lineNo,
      kind: "tax" as const,
      code: name.toLowerCase().replaceAll(" ", "_"),
      name,
      basis: null,
      quantity: 1,
      unitAmount: amount,
      amount,
      taxInclusive: true,
      taxRatePpm: 10_000,
    });
    const rows = orderRows(
      order([...orderLines, included(8, "Harbor levy", 400), included(9, "Port levy", 142)], {
        includedTax: 542,
      }),
    );
    expect(rows.filter((r) => r.kind === "note")).toEqual([
      { id: "included", label: "Taxes included in the prices", amount: "$5.42", kind: "note" },
    ]);
    expect(rows.map((r) => r.label)).not.toContain("Port levy");
  });

  it("leaves the note out when the order reports no included tax", () => {
    const rows = orderRows(order());
    expect(rows.map((r) => r.id)).not.toContain("included");
    expect(rows.some((r) => r.kind === "note")).toBe(false);
  });

  it("says a free line is at no charge, as checkout and the console do", () => {
    const infant: (typeof orderLines)[number] = {
      lineNo: 9,
      kind: "service",
      code: "infant",
      name: "Infant (under 3)",
      basis: "per_participant",
      quantity: 1,
      unitAmount: 0,
      amount: 0,
      taxInclusive: null,
      taxRatePpm: null,
    };
    const rows = orderRows(order([...orderLines, infant]));
    expect(rows.find((r) => r.id === "l9")).toMatchObject({
      label: "Infant (under 3)",
      detail: "1 at no charge",
    });
  });

  it("shows a tax with no rate without a detail", () => {
    const flat = {
      ...orderLines[6],
      lineNo: 8,
      name: "Flat levy",
      taxRatePpm: null,
      unitAmount: 100,
      amount: 100,
    };
    const rows = orderRows(order([...orderLines.slice(0, 6), flat as (typeof orderLines)[number]]));
    expect(rows.find((r) => r.id === "l8")).toEqual({
      id: "l8",
      label: "Flat levy",
      amount: "$1.00",
    });
  });

  it("shows a discount as an adjustment with its own sign, and no quantity", () => {
    const discount: (typeof orderLines)[number] = {
      lineNo: 6,
      kind: "discount",
      code: "HARBOR10",
      name: "HARBOR10, 10% off",
      basis: null,
      quantity: 1,
      unitAmount: 1150,
      amount: -1150,
      taxInclusive: null,
      taxRatePpm: null,
    };
    const rows = orderRows(order([...orderLines.slice(0, 5), discount, ...orderLines.slice(5)]));
    const row = rows.find((r) => r.id === "l6");
    expect(row).toEqual({
      id: "l6",
      label: "HARBOR10, 10% off",
      amount: `${minus}$11.50`,
      kind: "adjustment",
    });
    expect(row).not.toHaveProperty("detail");
  });

  it("shows the order's own numbers even when they do not add up", () => {
    const rows = orderRows(order(orderLines, { total: 777_700 }));
    expect(rows.at(-1)).toMatchObject({ id: "total", amount: "$7,777.00" });
  });

  it("gives every row its own id, and a total even when the order has no lines", () => {
    const ids = orderRows(order()).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(asRead(orderRows(order([], { includedTax: 0 })))).toEqual([
      { id: "total", label: "Total paid", amount: "$160.51", kind: "total" },
    ]);
  });
});

// What canceling gives ----------------------------------------------------------------------------

describe("refundSentence", () => {
  it("says a full refund, in dollars from cents", () => {
    expect(refundSentence(terms("full_refund"))).toBe("You get a full refund of $160.51.");
    expect(
      refundSentence(
        terms("full_refund", { paidAmount: 123_456, refundAmount: 123_456, refundBp: 10_000 }),
      ),
    ).toBe("You get a full refund of $1,234.56.");
  });

  it("says a percent refund by its share, the amount, and what was paid, with the odd cent as the server rounded it", () => {
    // Half of $160.51 is $80.255: the server rounds half up, so $80.26.
    expect(refundSentence(terms("percent_refund"))).toBe(
      "You get 50% back: $80.26 of the $160.51 you paid.",
    );
  });

  it.each([
    [1250, 2006, "12.5%", "$20.06"],
    [3333, 5350, "33.33%", "$53.50"],
    [2500, 4013, "25%", "$40.13"],
    [9999, 16_049, "99.99%", "$160.49"],
    [1, 2, "0.01%", "$0.02"],
  ])(
    "states %i basis points of $160.51 as %s, which is %s",
    (refundBp, refundAmount, share, back) => {
      expect(refundSentence(terms("percent_refund", { refundBp, refundAmount }))).toBe(
        `You get ${share} back: ${back} of the $160.51 you paid.`,
      );
    },
  );

  it("groups the thousands of a larger booking", () => {
    expect(
      refundSentence(
        terms("percent_refund", { paidAmount: 123_456, refundBp: 5000, refundAmount: 61_728 }),
      ),
    ).toBe("You get 50% back: $617.28 of the $1,234.56 you paid.");
  });

  it("says there is no refund, and whether the cutoff is why", () => {
    expect(refundSentence(terms("none", { beforeCutoff: true }))).toBe(
      "You get no refund: this booking's policy refunds nothing.",
    );
    expect(refundSentence(terms("none"))).toBe(
      "You get no refund: the cutoff for a refund has passed.",
    );
  });

  it("says a credit is the operator's to issue, and gives no amount", () => {
    const sentence = refundSentence(terms("credit"));
    expect(sentence).toBe("The policy gives a credit now, which the operator issues.");
    expect(sentence).not.toContain("$");
  });

  it("never prints a float, a negative amount, or a dash, whichever remedy", () => {
    for (const remedy of ["full_refund", "percent_refund", "none", "credit"] as const) {
      const sentence = refundSentence(terms(remedy));
      for (const money of sentence.match(/\$[\d,.]+/g) ?? []) {
        expect(money.replace(/\.$/, "")).toMatch(/^\$\d{1,3}(,\d{3})*\.\d{2}$/);
      }
      expect(sentence).not.toContain(emDash);
      expect(sentence).not.toContain(minus);
    }
  });
});

describe("cutoffSentence", () => {
  const trip = {
    timeZone: "America/New_York",
    localDate: "2026-10-07",
    startsAt: departsAt,
  };

  it("says when the remedy changes, on the marina's clock and named", () => {
    // 6:00 PM on Tue, Oct 6 in New York, which is Wednesday morning in Tokyo.
    expect(cutoffSentence(terms("full_refund"), trip)).toBe(
      `This holds until Tue, Oct 6 at 6:00${nbsp}PM EDT, New York time.`,
    );
  });

  it("says nothing once the cutoff has passed", () => {
    expect(cutoffSentence(terms("percent_refund"), trip)).toBeNull();
    expect(cutoffSentence(terms("none"), trip)).toBeNull();
    expect(cutoffSentence(terms("credit"), trip)).toBeNull();
  });

  it("reads another marina's clock, in its own zone's name", () => {
    expect(
      cutoffSentence(terms("full_refund"), {
        timeZone: "Pacific/Honolulu",
        localDate: "2026-10-07",
        startsAt: departsAt,
      }),
    ).toBe(`This holds until Tue, Oct 6 at 12:00${nbsp}PM HST, Honolulu time.`);
  });

  it("names the zone as it is at the cutoff, which can be either side of a clock change from the trip", () => {
    // The trip leaves at 8:00 AM EST on Sun, Nov 1; the cutoff, 24 hours before, is 9:00 AM EDT on Saturday.
    const november = {
      timeZone: "America/New_York",
      localDate: "2026-11-01",
      startsAt: "2026-11-01T13:00:00.000Z",
    };
    expect(
      cutoffSentence(terms("full_refund", { cutoffAt: "2026-10-31T13:00:00.000Z" }), november),
    ).toBe(`This holds until Sat, Oct 31 at 9:00${nbsp}AM EDT, New York time.`);
  });

  it("goes by the server's word that it is before the cutoff, never the device's clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(cutoffSentence(terms("full_refund"), trip)).toContain("This holds until");
    vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    expect(cutoffSentence(terms("none"), trip)).toBeNull();
  });

  it("reads the cutoff as the instant it is, not as a time in the host's zone", () => {
    // The same instant, written with another offset.
    expect(
      cutoffSentence(terms("full_refund", { cutoffAt: "2026-10-07T07:00:00+09:00" }), trip),
    ).toBe(`This holds until Tue, Oct 6 at 6:00${nbsp}PM EDT, New York time.`);
  });
});

describe("refundStateText", () => {
  const refund = (state: "requested" | "succeeded" | "failed", amount = 16_051) => ({
    state,
    amount,
    failureCode: null,
    requestedAt: "2026-10-06T23:00:00.000Z",
    settledAt: null,
  });

  it("says where the money is, by the refund's state", () => {
    expect(refundStateText(refund("succeeded"))).toBe(
      "$160.51 refunded to your original payment method",
    );
    expect(refundStateText(refund("requested"))).toBe("$160.51 refund on its way");
    expect(refundStateText(refund("failed"))).toBe(
      "$160.51 refund could not be sent yet; the operator will follow up",
    );
  });

  it("says the refund's own amount, to the cent", () => {
    expect(refundStateText(refund("requested", 8026))).toBe("$80.26 refund on its way");
    expect(refundStateText(refund("succeeded", 5))).toBe(
      "$0.05 refunded to your original payment method",
    );
    expect(refundStateText(refund("failed", 123_456))).toContain("$1,234.56");
  });

  it("does not call a failed refund done, or tell the guest to do anything about it", () => {
    const failed = refundStateText(refund("failed"));
    expect(failed).not.toMatch(/refunded to|on its way/);
    expect(failed).toContain("the operator will follow up");
  });
});

// The participant form ------------------------------------------------------------------------

const form = (over: Partial<ParticipantForm> = {}): ParticipantForm => ({
  name: "Ben Guest",
  isMinor: false,
  email: "",
  guardianName: "",
  guardianEmail: "",
  ...over,
});

describe("formOf", () => {
  it("starts an empty place as an adult with nothing filled in", () => {
    expect(formOf(null)).toEqual({
      name: "",
      isMinor: false,
      email: "",
      guardianName: "",
      guardianEmail: "",
    });
  });

  it("fills the form from the participant who holds the place", () => {
    expect(formOf(ava)).toEqual(form({ name: "Ava Guest" }));
    expect(formOf({ ...ava, email: "ava@example.test" })).toEqual(
      form({ name: "Ava Guest", email: "ava@example.test" }),
    );
    expect(formOf(theo)).toEqual({
      name: "Theo Guest",
      isMinor: true,
      email: "",
      guardianName: "Ava Guest",
      guardianEmail: "ava@example.test",
    });
  });

  it("gives back what was saved: the form of a participant sends the details they have", () => {
    expect(inputOf(formOf(ava))).toEqual({
      name: "Ava Guest",
      isMinor: false,
      email: null,
      guardian: null,
    });
    expect(inputOf(formOf(theo))).toEqual({
      name: "Theo Guest",
      isMinor: true,
      email: null,
      guardian: { name: "Ava Guest", email: "ava@example.test" },
    });
  });
});

describe("formErrors", () => {
  it("finds nothing wrong with an adult who has a name", () => {
    expect(formErrors(form())).toEqual({});
    expect(formErrors(form({ name: "Zoë O'Brien-Smith" }))).toEqual({});
  });

  it("asks for the name", () => {
    expect(formErrors(form({ name: "" }))).toEqual({ name: "Enter their full name" });
    expect(formErrors(form({ name: "   " }))).toEqual({ name: "Enter their full name" });
    expect(formErrors(form({ name: "\t\n " }))).toEqual({ name: "Enter their full name" });
  });

  it("allows a name of 120 characters, not counting the spaces around it, and not 121", () => {
    expect(formErrors(form({ name: "a".repeat(120) }))).toEqual({});
    expect(formErrors(form({ name: ` ${"a".repeat(120)} ` }))).toEqual({});
    expect(formErrors(form({ name: "a".repeat(121) }))).toEqual({
      name: "Their full name is too long (120 characters at most)",
    });
  });

  it.each([
    ["a tab", "Ava\tGuest"],
    ["a line break inside", "Ava\nGuest"],
    ["a null", "Ava\u0000Guest"],
    ["an escape", "Ava\u001bGuest"],
    ["a delete", "Ava\u007fGuest"],
    ["a C1 control at its start", "Ava\u0080Guest"],
    ["a C1 control at its end", "Ava\u009fGuest"],
    ["a next-line character", "Ava\u0085Guest"],
  ])("refuses a name with %s", (_what, name) => {
    expect(formErrors(form({ name }))).toEqual({
      name: "Use letters, spaces, and punctuation only",
    });
  });

  it("allows what is not a control character: accents, apostrophes, hyphens, and a no-break space", () => {
    for (const name of ["Zoë", "O'Brien-Smith", "Ava Guest", "李小龍", "Ava Guest Jr."]) {
      expect(formErrors(form({ name }))).toEqual({});
    }
  });

  it("does not count a line break around the name, which is trimmed off, as a control character", () => {
    expect(formErrors(form({ name: "Ava Guest\n" }))).toEqual({});
  });

  it("leaves their own email optional, and checks it when it is given", () => {
    expect(formErrors(form({ email: "" }))).toEqual({});
    expect(formErrors(form({ email: "   " }))).toEqual({});
    expect(formErrors(form({ email: "ben@example.test" }))).toEqual({});
    expect(formErrors(form({ email: "  ben@example.test  " }))).toEqual({});
    expect(formErrors(form({ email: "ben+trip@example.test" }))).toEqual({});
  });

  it.each([
    ["no at sign", "ben.example.test"],
    ["no domain", "ben@"],
    ["no name before the at sign", "@example.test"],
    ["no dot in the domain", "ben@example"],
    ["a space inside", "ben guest@example.test"],
    ["an accent", "zoë@example.test"],
    ["an accent in the domain", "ben@exämple.test"],
    ["a tab inside", "ben\t@example.test"],
    ["a trailing dot", "ben@example."],
  ])("refuses an email with %s, once it is given", (_what, email) => {
    expect(formErrors(form({ email }))).toEqual({
      email: "Enter an email address like name@example.com",
    });
  });

  it("allows an email of 254 characters and refuses one of 255", () => {
    const at = (length: number) => `${"a".repeat(length - "@example.test".length)}@example.test`;
    expect(at(254)).toHaveLength(254);
    expect(formErrors(form({ email: at(254) }))).toEqual({});
    expect(formErrors(form({ email: at(255) }))).toEqual({
      email: "Enter an email address like name@example.com",
    });
  });

  it("asks a minor for a parent or guardian's name and email", () => {
    expect(formErrors(form({ isMinor: true }))).toEqual({
      guardianName: "Enter the parent or guardian's name",
      guardianEmail: "Enter the parent or guardian's email",
    });
    expect(
      formErrors(
        form({ isMinor: true, guardianName: "Ava Guest", guardianEmail: "ava@example.test" }),
      ),
    ).toEqual({});
  });

  it("checks a guardian's name and email as it checks anyone's", () => {
    expect(
      formErrors(form({ isMinor: true, guardianName: "A".repeat(121), guardianEmail: "x@y" })),
    ).toEqual({
      guardianName: "The parent or guardian's name is too long (120 characters at most)",
      guardianEmail: "Enter an email address like name@example.com",
    });
    expect(
      formErrors(
        form({ isMinor: true, guardianName: "Ava\tGuest", guardianEmail: "ava@example.test" }),
      ),
    ).toEqual({ guardianName: "Use letters, spaces, and punctuation only" });
    expect(
      formErrors(form({ isMinor: true, guardianName: "   ", guardianEmail: "ava@example.test" })),
    ).toEqual({ guardianName: "Enter the parent or guardian's name" });
  });

  it("checks a minor's own optional email, too, and reports every problem at once", () => {
    expect(
      formErrors(
        form({ name: "", email: "no", isMinor: true, guardianName: "", guardianEmail: "" }),
      ),
    ).toEqual({
      name: "Enter their full name",
      email: "Enter an email address like name@example.com",
      guardianName: "Enter the parent or guardian's name",
      guardianEmail: "Enter the parent or guardian's email",
    });
  });

  it("ignores what is typed for a guardian once the guest says the person is an adult", () => {
    expect(formErrors(form({ isMinor: false, guardianName: "\t", guardianEmail: "nope" }))).toEqual(
      {},
    );
  });
});

describe("inputOf", () => {
  it("sends an adult with no email as the API takes them: no email and no guardian", () => {
    expect(inputOf(form())).toEqual({
      name: "Ben Guest",
      isMinor: false,
      email: null,
      guardian: null,
    });
  });

  it("trims the name and the email, and sends no email for a blank one", () => {
    expect(inputOf(form({ name: "  Ben Guest  ", email: "  ben@example.test  " }))).toEqual({
      name: "Ben Guest",
      isMinor: false,
      email: "ben@example.test",
      guardian: null,
    });
    expect(inputOf(form({ email: "   " })).email).toBeNull();
  });

  it("sends a minor's guardian, trimmed", () => {
    expect(
      inputOf(
        form({
          name: "Theo Guest",
          isMinor: true,
          guardianName: " Ava Guest ",
          guardianEmail: " ava@example.test ",
        }),
      ),
    ).toEqual({
      name: "Theo Guest",
      isMinor: true,
      email: null,
      guardian: { name: "Ava Guest", email: "ava@example.test" },
    });
  });

  it("sends no guardian for an adult, even when the form still holds one from before", () => {
    expect(
      inputOf(
        form({ isMinor: false, guardianName: "Ava Guest", guardianEmail: "ava@example.test" }),
      ),
    ).toMatchObject({ isMinor: false, guardian: null });
  });

  it("sends what the contract takes, for every form the page lets through", () => {
    const good = [
      form(),
      form({ name: "  Zoë O'Brien-Smith ", email: " zoe@example.test " }),
      form({ name: "Theo Guest", isMinor: true, guardianName: "Ava", guardianEmail: "a@b.test" }),
      form({
        name: "Theo Guest",
        isMinor: true,
        email: "theo@example.test",
        guardianName: "Ava Guest",
        guardianEmail: "ava@example.test",
      }),
      form({ isMinor: false, guardianName: "left over", guardianEmail: "left over" }),
    ];
    for (const each of good) {
      expect(formErrors(each)).toEqual({});
      expect(ParticipantInput.safeParse(inputOf(each)).success, JSON.stringify(each)).toBe(true);
    }
  });

  it("is refused by the contract wherever the page refuses the form", () => {
    const bad = [
      form({ name: "" }),
      form({ name: "Ava\tGuest" }),
      form({ name: "a".repeat(121) }),
      form({ email: "not an email" }),
      form({ isMinor: true }),
      form({ isMinor: true, guardianName: "Ava", guardianEmail: "nope" }),
    ];
    for (const each of bad) {
      expect(Object.keys(formErrors(each)).length, JSON.stringify(each)).toBeGreaterThan(0);
      expect(ParticipantInput.safeParse(inputOf(each)).success, JSON.stringify(each)).toBe(false);
    }
  });
});
