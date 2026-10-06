import { describe, expect, it } from "vitest";
import {
  type AddressState,
  type BookingAddress,
  bookingHref,
  isUuid,
  maxCount,
  readAddress,
  restartHref,
  tripIdOf,
  writeAddress,
} from "./address.ts";
import { charterTripId, tripId } from "./fixtures.ts";

const quoteId = "0b7f3a52-9c1e-4d2a-8f6b-000000000001";

/** The address with nothing asked for. */
const bare: BookingAddress = {
  tripId,
  party: null,
  tickets: {},
  guests: null,
  addOns: {},
  step: "party",
  quoteId: null,
};

const read = (search: string) => readAddress(tripId, search);

/** What the page's state writes: shared seats on the party step, unless a field says otherwise. */
const state = (fields: Partial<AddressState> = {}): AddressState => ({
  kind: "tickets",
  tickets: {},
  guests: 1,
  addOns: {},
  step: "party",
  quoteId: null,
  ...fields,
});

describe("isUuid", () => {
  it("accepts a UUID in either case and nothing else", () => {
    expect(isUuid(tripId)).toBe(true);
    expect(isUuid(tripId.toUpperCase())).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(`${tripId}0`)).toBe(false);
    expect(isUuid(` ${tripId}`)).toBe(false);
  });
});

describe("tripIdOf", () => {
  it("reads the trip a /book/<id> path names", () => {
    expect(tripIdOf(`/book/${tripId}`)).toBe(tripId);
    expect(tripIdOf(`/book/${charterTripId}`)).toBe(charterTripId);
  });

  it("returns an upper-case id in lower case", () => {
    expect(tripIdOf(`/book/${tripId.toUpperCase()}`)).toBe(tripId);
  });

  it("accepts one trailing slash", () => {
    expect(tripIdOf(`/book/${tripId}/`)).toBe(tripId);
  });

  it.each([
    ["not a UUID", "/book/not-a-uuid"],
    ["a short UUID", `/book/${tripId.slice(1)}`],
    ["a long UUID", `/book/${tripId}0`],
    ["a UUID without hyphens", `/book/${tripId.replaceAll("-", "")}`],
    ["an encoded UUID", `/book/${encodeURIComponent(`${tripId}/x`)}`],
  ])("refuses a malformed id: %s", (_name, path) => {
    expect(tripIdOf(path)).toBeNull();
  });

  it.each([
    "/",
    "/trips",
    "/book",
    "/book/",
    "//",
    `/booking/${tripId}`,
    `/book/${tripId}/extra`,
    `/book/${tripId}//`,
    `/x/book/${tripId}`,
    `book/${tripId}`,
  ])("returns null for the other path %s", (path) => {
    expect(tripIdOf(path)).toBeNull();
  });
});

describe("bookingHref", () => {
  it("sends one guest, or none named, to the booking page with no query", () => {
    expect(bookingHref(tripId)).toBe(`/book/${tripId}`);
    expect(bookingHref(tripId, 1)).toBe(`/book/${tripId}`);
    expect(bookingHref(tripId, 0)).toBe(`/book/${tripId}`);
  });

  it("carries a party of more than one", () => {
    expect(bookingHref(tripId, 4)).toBe(`/book/${tripId}?party=4`);
  });
});

describe("readAddress", () => {
  it("reads the trip it was given, and nothing asked for from an empty query", () => {
    expect(read("")).toEqual(bare);
    expect(read("?")).toEqual(bare);
    expect(readAddress(charterTripId, "")).toEqual({ ...bare, tripId: charterTripId });
  });

  it("reads ticket counts from t. and add-on counts from a. params", () => {
    expect(read("?t.adult=2&t.child=1&a.photo=1&a.drinks=2")).toEqual({
      ...bare,
      tickets: { adult: 2, child: 1 },
      addOns: { photo: 1, drinks: 2 },
    });
  });

  it("reads the party size and the charter's guests", () => {
    expect(read("?party=4")).toEqual({ ...bare, party: 4 });
    expect(read("?guests=6")).toEqual({ ...bare, guests: 6 });
    expect(read("?party=4&guests=6")).toEqual({ ...bare, party: 4, guests: 6 });
  });

  describe("counts", () => {
    const params = ["t.adult", "a.photo", "party", "guests"];

    /** The count a parameter reads as, or null when the address drops it. */
    function countOf(param: string, value: string): number | null {
      const address = read(`?${param}=${encodeURIComponent(value)}`);
      if (param === "party") return address.party;
      if (param === "guests") return address.guests;
      const counts = param.startsWith("t.") ? address.tickets : address.addOns;
      return counts[param.slice(2)] ?? null;
    }

    it.each([
      ["1", 1],
      ["2", 2],
      ["42", 42],
      ["500", 500],
      ["07", 7],
    ])("reads %j as %i in every count", (value, expected) => {
      for (const param of params) expect(countOf(param, value)).toBe(expected);
    });

    it.each([
      ["0", "zero"],
      ["000", "zeros"],
      ["501", "above the most"],
      ["1000", "four digits"],
      ["0001", "four digits with leading zeros"],
      ["1e2", "an exponent"],
      ["-1", "negative"],
      ["+1", "signed"],
      ["1.5", "fractional"],
      ["0x10", "hexadecimal"],
      [" 3", "padded"],
      ["abc", "text"],
      ["", "empty"],
    ])("drops %j (%s) in every count", (value) => {
      for (const param of params) expect(countOf(param, value)).toBeNull();
    });

    it("drops a bad count and keeps the good ones beside it", () => {
      expect(read("?t.adult=2&t.child=0&t.infant=501&a.photo=1")).toEqual({
        ...bare,
        tickets: { adult: 2 },
        addOns: { photo: 1 },
      });
    });
  });

  describe("codes", () => {
    it("keeps a code of 1 to 32 lower-case letters, digits, and underscores", () => {
      const longest = `a${"b".repeat(31)}`;
      expect(read(`?t.${longest}=1&a.snorkel_gear2=3&t.a=1`)).toEqual({
        ...bare,
        tickets: { [longest]: 1, a: 1 },
        addOns: { snorkel_gear2: 3 },
      });
    });

    it.each([
      ["upper case", "Adult"],
      ["a leading digit", "1x"],
      ["a leading underscore", "_adult"],
      ["a hyphen", "a-b"],
      ["a dot", "a.b"],
      ["a space", "a b"],
      ["more than 32 characters", `a${"b".repeat(32)}`],
      ["no characters", ""],
      ["a prototype name", "__proto__"],
    ])("drops a code with %s", (_name, code) => {
      const address = read(`?t.${encodeURIComponent(code)}=1&a.${encodeURIComponent(code)}=1`);
      expect(address.tickets).toEqual({});
      expect(address.addOns).toEqual({});
    });

    it("drops params with another prefix", () => {
      expect(read("?x.adult=1&ticket.adult=1&t_adult=1&adult=1&T.adult=1&A.photo=1")).toEqual(bare);
    });
  });

  describe("step", () => {
    it.each(["party", "details", "pay", "status"] as const)("reads step=%s", (step) => {
      expect(read(`?step=${step}`).step).toBe(step);
    });

    it.each(["bogus", "DETAILS", "", "confirm", "details ", "details,pay"])(
      "falls back to the party step for step=%j",
      (step) => {
        expect(read(`?step=${encodeURIComponent(step)}`).step).toBe("party");
      },
    );

    it("starts on the party step when there is none", () => {
      expect(read("?t.adult=1").step).toBe("party");
    });
  });

  describe("quote", () => {
    it("reads a quote id and returns it in lower case", () => {
      expect(read(`?quote=${quoteId}`).quoteId).toBe(quoteId);
      expect(read(`?quote=${quoteId.toUpperCase()}`).quoteId).toBe(quoteId);
    });

    it.each([
      ["not a UUID", "nope"],
      ["empty", ""],
      ["a short UUID", quoteId.slice(1)],
      ["a long UUID", `${quoteId}0`],
      ["a UUID with a hyphen too few", quoteId.replace("-", "")],
    ])("drops a quote that is %s", (_name, value) => {
      expect(read(`?quote=${encodeURIComponent(value)}`).quoteId).toBeNull();
    });
  });

  it("reads nothing it has no place for", () => {
    const search = [
      "email=ava%40example.test",
      "name=Ava",
      "promotionCode=HARBOR10",
      "checkoutSecret=abc",
      "sessionId=5d0c4a1e-2b3c-4d5e-8f60-000000000000",
      "tripId=nope",
    ].join("&");
    expect(read(`?${search}`)).toEqual(bare);
  });

  it("keeps the largest count an address may ask for", () => {
    expect(maxCount).toBe(500);
  });
});

describe("writeAddress", () => {
  it("writes ticket and add-on counts, and leaves zeros out", () => {
    const query = writeAddress(
      state({
        tickets: { adult: 2, child: 0, infant: 1 },
        addOns: { photo: 0, drinks: 2 },
      }),
    );
    expect(query).toBe("?t.adult=2&t.infant=1&a.drinks=2");
  });

  it("writes nothing at all for no counts on the party step", () => {
    expect(writeAddress(state())).toBe("");
    expect(writeAddress(state({ tickets: { adult: 0 }, addOns: { photo: 0 } }))).toBe("");
  });

  it("leaves the party step out and names any other", () => {
    const tickets = { adult: 1 };
    expect(writeAddress(state({ tickets, step: "party" }))).toBe("?t.adult=1");
    expect(writeAddress(state({ tickets, step: "details" }))).toBe("?t.adult=1&step=details");
    expect(writeAddress(state({ tickets, step: "pay" }))).toBe("?t.adult=1&step=pay");
    expect(writeAddress(state({ tickets, step: "status" }))).toBe("?t.adult=1&step=status");
  });

  it("writes the quote on the details step only", () => {
    const tickets = { adult: 1 };
    expect(writeAddress(state({ tickets, step: "details", quoteId }))).toBe(
      `?t.adult=1&step=details&quote=${quoteId}`,
    );
    expect(writeAddress(state({ tickets, step: "details", quoteId: null }))).toBe(
      "?t.adult=1&step=details",
    );
    expect(writeAddress(state({ tickets, step: "party", quoteId }))).toBe("?t.adult=1");
    expect(writeAddress(state({ tickets, step: "pay", quoteId }))).toBe("?t.adult=1&step=pay");
    expect(writeAddress(state({ tickets, step: "status", quoteId }))).toBe(
      "?t.adult=1&step=status",
    );
  });

  it("writes a charter's guests and add-ons, and no tickets", () => {
    expect(
      writeAddress(
        state({ kind: "charter", guests: 6, tickets: { adult: 3 }, addOns: { lunch: 3 } }),
      ),
    ).toBe("?guests=6&a.lunch=3");
  });

  it("writes tickets, add-ons, the step, and the quote in that order", () => {
    const query = writeAddress(
      state({
        tickets: { adult: 2, child: 1 },
        addOns: { photo: 1 },
        step: "details",
        quoteId,
      }),
    );
    expect(query).toBe(`?t.adult=2&t.child=1&a.photo=1&step=details&quote=${quoteId}`);
  });

  it("is read back as it was written", () => {
    const written = state({
      tickets: { adult: 2, child: 1 },
      addOns: { drinks: 4 },
      step: "details",
      quoteId,
    });
    expect(read(writeAddress(written))).toEqual({
      ...bare,
      tickets: { adult: 2, child: 1 },
      addOns: { drinks: 4 },
      step: "details",
      quoteId,
    });
    const charter = state({ kind: "charter", guests: 6, addOns: { lunch: 6 }, step: "pay" });
    expect(read(writeAddress(charter))).toEqual({
      ...bare,
      guests: 6,
      addOns: { lunch: 6 },
      step: "pay",
    });
  });
});

describe("restartHref", () => {
  const asked: BookingAddress = {
    ...bare,
    party: 4,
    tickets: { adult: 2, child: 1 },
    addOns: { photo: 1 },
    step: "pay",
    quoteId,
  };

  it("goes to the booking page with the party the address asked for", () => {
    expect(restartHref(asked)).toBe(`/book/${tripId}?t.adult=2&t.child=1&party=4&a.photo=1`);
  });

  it("drops the step and the quote", () => {
    const href = restartHref(asked);
    expect(href).not.toContain("step");
    expect(href).not.toContain("quote");
    expect(href).not.toContain(quoteId);
  });

  it("keeps a charter's guests", () => {
    expect(restartHref({ ...bare, guests: 6, addOns: { lunch: 6 } })).toBe(
      `/book/${tripId}?guests=6&a.lunch=6`,
    );
    expect(restartHref({ ...asked, tickets: {}, guests: 6 })).toBe(
      `/book/${tripId}?guests=6&party=4&a.photo=1`,
    );
  });

  it("has no query when nothing was asked for", () => {
    expect(restartHref(bare)).toBe(`/book/${tripId}`);
  });

  it("names the address's own trip", () => {
    expect(restartHref({ ...bare, tripId: charterTripId })).toBe(`/book/${charterTripId}`);
  });
});
