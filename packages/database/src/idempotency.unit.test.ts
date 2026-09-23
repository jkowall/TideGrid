import { describe, expect, it } from "vitest";
import { canonicalJson, requestHash } from "./idempotency.ts";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("requestHash", () => {
  it("is stable across key order and sensitive to every part", async () => {
    const base = { method: "post", route: "/r/{id}", params: { id: "1" }, body: { a: 1, b: 2 } };
    const same = await requestHash({ ...base, body: { b: 2, a: 1 } });
    expect(await requestHash(base)).toBe(same);
    expect(same).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { method: "PUT" },
      { route: "/r/{other}" },
      { params: { id: "2" } },
      { body: { a: 1, b: 3 } },
    ]) {
      expect(await requestHash({ ...base, ...change })).not.toBe(same);
    }
  });
});
