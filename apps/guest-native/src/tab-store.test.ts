import { describe, expect, it } from "vitest";
import { SessionStore, storageKey } from "./sessions.ts";
import { tabStore } from "./tab-store.ts";

/** A stand-in for the tab's sessionStorage. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

describe("booking sessions in a browser (the phone app demo)", () => {
  it("keeps the same record the phone keeps, one key per operator", async () => {
    const storage = memoryStorage();
    const store = new SessionStore(
      tabStore(() => storage),
      "demo-harbor",
    );
    const now = Date.parse("2026-11-24T12:00:00Z");
    const session = {
      token: "t".repeat(43),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      reference: "ABCD2345",
    };
    await store.add(session, now);
    expect(await store.list(now)).toEqual([session]);
    const raw = storage.getItem(storageKey("demo-harbor")) ?? "";
    expect(JSON.parse(raw)).toEqual([session]);
  });

  it("falls back to memory when the browser refuses storage", async () => {
    const refused = () => {
      throw new Error("SecurityError");
    };
    const store = new SessionStore(tabStore(refused), "demo-harbor");
    const now = Date.parse("2026-11-24T12:00:00Z");
    const session = {
      token: "t".repeat(43),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      reference: "ABCD2345",
    };
    await store.add(session, now);
    expect(await store.list(now)).toEqual([session]);
  });
});
