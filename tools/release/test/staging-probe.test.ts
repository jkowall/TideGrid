import { describe, expect, it } from "vitest";
import {
  assertStagingEndpoint,
  optionsFromEnv,
  type ProbeOptions,
  percentile,
  readAfterWrite,
} from "../src/staging-probe.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeApi(readStatus: (n: number) => number): ProbeOptions {
  let reads = 0;
  let quotes = 0;
  return {
    api: "https://api-staging.example.test",
    origin: "https://demo.example.test",
    now: () => Date.parse("2026-11-15T12:00:00Z"),
    sleep: async () => undefined,
    fetch: async (url, init) => {
      if (url.includes("/v1/public/trips?"))
        return json(200, {
          trips: [
            {
              tripId: "t1",
              salesCloseAt: "2026-11-20T00:00:00Z",
              product: { kind: "shared_seat" },
            },
          ],
        });
      if (url.endsWith("/offer"))
        return json(200, {
          offer: { tickets: [{ code: "adult" }], charter: null, product: { minPartySize: 1 } },
        });
      if (url.endsWith("/v1/public/quotes") && init?.method === "POST") {
        quotes++;
        return json(201, { quote: { quoteId: `q${quotes}` } });
      }
      const m = url.match(/\/v1\/public\/quotes\/(q\d+)$/);
      if (m) {
        reads++;
        const status = readStatus(reads);
        return status === 200 ? json(200, { quote: { quoteId: m[1] } }) : json(status, {});
      }
      return json(500, {});
    },
  };
}

describe("staging probes", () => {
  it("takes nearest-rank percentiles", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 0.5)).toBe(10);
    expect(percentile(xs, 0.95)).toBe(19);
    expect(percentile([], 0.95)).toBeNull();
  });

  it("only probes the staging API", () => {
    expect(() =>
      optionsFromEnv({ PROBE_API: "https://api.tidegrid.us", PROBE_ORIGIN: "https://a.test" }),
    ).toThrow(/staging API/);
    expect(
      optionsFromEnv({
        PROBE_API: "https://api-staging.tidegrid.us/",
        PROBE_ORIGIN: "https://demo-harbor.book.tidegrid.us",
      }),
    ).toEqual({
      api: "https://api-staging.tidegrid.us",
      origin: "https://demo-harbor.book.tidegrid.us",
    });
  });

  it("passes when every write reads back", async () => {
    const r = await readAfterWrite(
      fakeApi(() => 200),
      5,
    );
    expect(r).toMatchObject({ outcome: "pass", ok: 5, stale: 0 });
  });

  it("fails on a stale read", async () => {
    const r = await readAfterWrite(
      fakeApi((n) => (n === 3 ? 404 : 200)),
      5,
    );
    expect(r).toMatchObject({ outcome: "fail", ok: 4, stale: 1 });
  });

  it("counts a refused write apart from a stale read", async () => {
    const o = fakeApi(() => 200);
    let posts = 0;
    const flaky: ProbeOptions = {
      ...o,
      fetch: async (url, init) => {
        if (init?.method === "POST" && ++posts === 2) return json(429, {});
        return o.fetch(url, init);
      },
    };
    const r = await readAfterWrite(flaky, 8);
    expect(r).toMatchObject({ outcome: "pass", ok: 7, stale: 0, writeFailures: 1 });
  });

  it("refuses to restart a compute that is not staging's", async () => {
    const o = fakeApi(() => 200);
    const t = { apiKey: "k", project: "p", branchId: "br-s", endpointId: "ep-1" };
    const withNeon = (branch: unknown, endpoint: unknown): ProbeOptions => ({
      ...o,
      fetch: async (url) =>
        url.includes("/branches/") ? json(200, { branch }) : json(200, { endpoint }),
    });
    await expect(
      assertStagingEndpoint(withNeon({ name: "main", default: true }, { branch_id: "br-s" }), t),
    ).rejects.toThrow(/not the staging branch/);
    await expect(
      assertStagingEndpoint(withNeon({ name: "staging" }, { branch_id: "br-main" }), t),
    ).rejects.toThrow(/not on the staging branch/);
    await expect(
      assertStagingEndpoint(withNeon({ name: "staging" }, { branch_id: "br-s" }), t),
    ).resolves.toBeUndefined();
  });
});
