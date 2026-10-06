// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testNow } from "../booking/fixtures.ts";
import { linkToken, reference, sessionToken } from "./fixtures.ts";
import {
  clearSession,
  forgetLinkToken,
  loadSession,
  readLinkToken,
  type StoredSession,
  storeSession,
} from "./session.ts";

const storageKey = "tidegrid.manage.v1";
const minute = 60_000;
const now = testNow.getTime();
const expiry = now + 60 * minute;

const record: StoredSession = {
  token: sessionToken,
  expiresAt: new Date(expiry).toISOString(),
  reference,
  linkToken,
};

const stored = () => window.sessionStorage.getItem(storageKey);
const store = (value: unknown) =>
  window.sessionStorage.setItem(
    storageKey,
    typeof value === "string" ? value : JSON.stringify(value),
  );

/** The record with one field removed. */
const without = (key: keyof StoredSession) =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/manage");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("storeSession and loadSession", () => {
  it("reads back the session that was stored", () => {
    storeSession(record);
    expect(loadSession(now)).toEqual(record);
  });

  it("keeps the session in this tab's session storage under one key, and nowhere else", () => {
    storeSession(record);
    expect(window.sessionStorage.length).toBe(1);
    expect(Object.keys(JSON.parse(stored() ?? "{}")).sort()).toEqual([
      "expiresAt",
      "linkToken",
      "reference",
      "token",
    ]);
    expect(window.localStorage.length).toBe(0);
  });

  it("stores no name, email, or other detail of the guest", () => {
    storeSession(record);
    expect(stored()).not.toMatch(/Ava|Guest|example\.test|@/);
  });

  it("keeps a session opened from the checkout as it is, with no link to ask for a new one from", () => {
    const fromCheckout: StoredSession = {
      token: sessionToken,
      expiresAt: record.expiresAt,
      reference,
    };
    storeSession(fromCheckout);
    const read = loadSession(now);
    expect(read).toEqual(fromCheckout);
    expect(read).not.toHaveProperty("linkToken");
  });

  it("keeps one session: opening another booking in the tab replaces the last", () => {
    storeSession(record);
    const next = { ...record, token: "next_session_".padEnd(43, "N"), reference: "7HM2P9TW" };
    storeSession(next);
    expect(window.sessionStorage.length).toBe(1);
    expect(loadSession(now)).toEqual(next);
  });

  it("reads nothing when nothing is stored, and stores nothing by reading", () => {
    expect(loadSession(now)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("hands back only the four fields it knows, whatever else the record holds", () => {
    store({ ...record, password: "hunter2", booker: "Ava Guest" });
    expect(loadSession(now)).toEqual(record);
  });

  it("keeps the session but not a link token that is not well formed", () => {
    store({ ...record, linkToken: "short" });
    const read = loadSession(now);
    expect(read).toEqual({
      token: sessionToken,
      expiresAt: record.expiresAt,
      reference,
    });
    expect(read).not.toHaveProperty("linkToken");
    store({ ...record, linkToken: 43 });
    expect(loadSession(now)).not.toHaveProperty("linkToken");
  });

  it("reads the device's clock when no time is given", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(testNow);
    storeSession(record);
    expect(loadSession()).toEqual(record);
    vi.setSystemTime(expiry + 1);
    expect(loadSession()).toBeNull();
    expect(stored()).toBeNull();
  });
});

describe("a session that cannot be trusted", () => {
  const bad: Array<[string, unknown]> = [
    ["malformed JSON", "{not json"],
    ["JSON null", "null"],
    ["a JSON string", '"text"'],
    ["a JSON number", "42"],
    ["a JSON array", "[]"],
    ["an empty object", "{}"],
    ["a token that is too short", { ...record, token: sessionToken.slice(1) }],
    ["a token that is too long", { ...record, token: `${sessionToken}S` }],
    [
      "a token with a character outside base64url",
      { ...record, token: `+${sessionToken.slice(1)}` },
    ],
    ["a token with a slash", { ...record, token: `/${sessionToken.slice(1)}` }],
    ["a token that is not a string", { ...record, token: 43 }],
    ["a missing token", without("token")],
    ["a missing expiry", without("expiresAt")],
    ["an expiry that is not a date", { ...record, expiresAt: "soon" }],
    ["an expiry that is not a string", { ...record, expiresAt: expiry }],
    ["a missing reference", without("reference")],
    ["a reference that is not a string", { ...record, reference: 12_345_678 }],
  ];

  it.each(bad)("is removed on read: %s", (_name, value) => {
    store(value);
    expect(loadSession(now)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("is removed on read, so a second read finds nothing either", () => {
    store("{not json");
    expect(loadSession(now)).toBeNull();
    expect(loadSession(now)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("a session past its expiry", () => {
  it("is kept until the instant it expires, by the device's clock", () => {
    storeSession(record);
    expect(loadSession(now)).toEqual(record);
    expect(loadSession(expiry - 1)).toEqual(record);
    expect(stored()).not.toBeNull();
  });

  it("is dropped at the instant it expires", () => {
    storeSession(record);
    expect(loadSession(expiry)).toBeNull();
    expect(stored()).toBeNull();
  });

  it("is dropped when it is long past, and stays dropped", () => {
    storeSession(record);
    expect(loadSession(expiry + 24 * 60 * minute)).toBeNull();
    expect(stored()).toBeNull();
    expect(loadSession(now)).toBeNull();
  });
});

describe("clearSession", () => {
  it("removes the stored session", () => {
    storeSession(record);
    clearSession();
    expect(stored()).toBeNull();
    expect(loadSession(now)).toBeNull();
  });

  it("does nothing when there is none", () => {
    clearSession();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("leaves the tab's other storage alone", () => {
    window.sessionStorage.setItem("tidegrid.checkout", "kept");
    window.localStorage.setItem("other", "kept");
    storeSession(record);
    clearSession();
    expect(window.sessionStorage.getItem("tidegrid.checkout")).toBe("kept");
    expect(window.localStorage.getItem("other")).toBe("kept");
  });
});

describe("storage that cannot be used", () => {
  const denied = () => {
    throw new DOMException("denied", "SecurityError");
  };

  it("reads nothing, stores nothing, and clears nothing, without an error, when the browser blocks storage", () => {
    storeSession(record);
    const blocked = vi.spyOn(window, "sessionStorage", "get").mockImplementation(denied);
    expect(loadSession(now)).toBeNull();
    expect(() => storeSession({ ...record, reference: "7HM2P9TW" })).not.toThrow();
    expect(() => clearSession()).not.toThrow();
    expect(blocked).toHaveBeenCalled();
    // What was there before is as it was: the blocked calls changed nothing.
    blocked.mockRestore();
    expect(loadSession(now)).toEqual(record);
  });

  it("goes on without a stored session when storage is full", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => storeSession(record)).not.toThrow();
    expect(loadSession(now)).toBeNull();
  });

  it("is still reported as nothing when a bad record cannot be removed", () => {
    store("{not json");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(loadSession(now)).toBeNull();
    expect(() => clearSession()).not.toThrow();
  });
});

describe("readLinkToken", () => {
  const token = linkToken;

  it("takes the token of a #t= fragment of exactly 43 base64url characters", () => {
    expect(readLinkToken(`#t=${token}`)).toBe(token);
  });

  it("takes every base64url character, the hyphen and the underscore too", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    expect(alphabet).toHaveLength(64);
    // Every character appears in one of the two windows of 43.
    for (const span of [alphabet.slice(0, 43), alphabet.slice(-43)]) {
      expect(readLinkToken(`#t=${span}`)).toBe(span);
    }
    expect(readLinkToken(`#t=${"-".repeat(43)}`)).toBe("-".repeat(43));
    expect(readLinkToken(`#t=${"_".repeat(43)}`)).toBe("_".repeat(43));
  });

  const refused: Array<[string, string]> = [
    ["42 characters", `#t=${token.slice(1)}`],
    ["44 characters", `#t=${token}x`],
    ["a plus sign", `#t=+${token.slice(1)}`],
    ["a slash", `#t=/${token.slice(1)}`],
    ["padding", `#t=${token.slice(1)}=`],
    ["a space", `#t= ${token.slice(1)}`],
    ["a percent escape", `#t=%41${token.slice(3)}`],
    ["a character outside ASCII", `#t=é${token.slice(1)}`],
    ["more after the token", `#t=${token}&x=1`],
    ["another field first", `#x=1&t=${token}`],
    ["a trailing newline", `#t=${token}\n`],
    ["a leading space", ` #t=${token}`],
    ["a capital T", `#T=${token}`],
    ["another name", `#token=${token}`],
    ["a slash before the name", `#/t=${token}`],
    ["no hash", `t=${token}`],
    ["a query instead of a fragment", `?t=${token}`],
    ["no token", "#t="],
    ["a bare hash", "#"],
    ["nothing", ""],
  ];

  it.each(refused)("takes nothing from a fragment with %s", (_what, hash) => {
    expect(readLinkToken(hash)).toBeNull();
  });

  it("reads the address's own fragment when none is given, and changes nothing", () => {
    window.history.replaceState(null, "", `/manage?from=email#t=${token}`);
    const entries = window.history.length;
    expect(readLinkToken()).toBe(token);
    expect(readLinkToken()).toBe(token);
    expect(window.location.hash).toBe(`#t=${token}`);
    expect(window.location.search).toBe("?from=email");
    expect(window.history.length).toBe(entries);
  });

  it("finds nothing in an address with no fragment", () => {
    expect(readLinkToken()).toBeNull();
    window.history.replaceState(null, "", `/manage?t=${token}`);
    expect(readLinkToken()).toBeNull();
  });
});

describe("forgetLinkToken", () => {
  const token = linkToken;

  it("takes the fragment out of the address and keeps the path and the query", () => {
    window.history.replaceState(null, "", `/manage?from=email#t=${token}`);
    forgetLinkToken();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/manage");
    expect(window.location.search).toBe("?from=email");
    expect(window.location.href).not.toContain("#");
    expect(window.location.href).not.toContain(token);
    expect(readLinkToken()).toBeNull();
  });

  it("replaces this history entry rather than adding one, and keeps its state", () => {
    window.history.replaceState({ marker: "email" }, "", `/manage#t=${token}`);
    const entries = window.history.length;
    forgetLinkToken();
    expect(window.history.length).toBe(entries);
    expect(window.history.state).toEqual({ marker: "email" });
    expect(window.location.hash).toBe("");
  });

  it("is not a fragment change, which would add an entry to the history: the check above has teeth", () => {
    window.history.replaceState(null, "", `/manage#t=${token}`);
    const entries = window.history.length;
    window.location.hash = "";
    expect(window.history.length).toBe(entries + 1);
  });

  it("takes out any fragment, not only a token's", () => {
    window.history.replaceState(null, "", "/manage#something");
    forgetLinkToken();
    expect(window.location.href).toBe("http://localhost:3000/manage");
  });

  it("does nothing, and does not touch the history, when the address has no fragment", () => {
    window.history.replaceState(null, "", "/manage?from=email");
    const replace = vi.spyOn(window.history, "replaceState");
    forgetLinkToken();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.href).toBe("http://localhost:3000/manage?from=email");
  });

  it("is idempotent: the second call finds nothing to take out", () => {
    window.history.replaceState(null, "", `/manage#t=${token}`);
    const replace = vi.spyOn(window.history, "replaceState");
    forgetLinkToken();
    forgetLinkToken();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("");
  });
});
