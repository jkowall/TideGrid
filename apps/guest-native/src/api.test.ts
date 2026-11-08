import { describe, expect, it, vi } from "vitest";
import { isoDate, loadStart, loadTrips } from "./api.ts";
import { endpointFor, type Variant, variantFor } from "./variant.ts";

const harbor = variantFor("demo-harbor") as Variant;
const endpoint = endpointFor(harbor) ?? { apiBase: "", origin: "" };

const brand = {
  version: 1,
  name: "Demo Harbor Charters",
  tagline: "Sunrise fishing and sunset sails from a synthetic marina",
  colors: { primary: "#0b3c5d", accent: "#e0a526" },
  fonts: { display: "fraunces", body: "source-sans-3" },
  contact: { email: "hello@demo-harbor.test", phone: "+13055550142" },
  legal: { terms: "/legal/terms", privacy: "/legal/privacy" },
  locale: "en-US",
  capabilities: [],
};

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("loadStart", () => {
  it("sends the variant's origin, no credentials, and returns its brand", async () => {
    const fetchImpl = reply(200, {
      tenant: { slug: "demo-harbor", name: "Demo Harbor Charters" },
      brand,
    });
    const start = await loadStart(harbor, endpoint, fetchImpl);
    expect(start.kind).toBe("ready");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tidegrid.us/v1/public/tenant");
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>).origin).toBe(
      "https://demo-harbor.book.tidegrid.us",
    );
  });

  it("fails closed when the API answers for another operator", async () => {
    const fetchImpl = reply(200, {
      tenant: { slug: "demo-reef", name: "Demo Reef Divers" },
      brand: { ...brand, name: "Demo Reef Divers" },
    });
    expect(await loadStart(harbor, endpoint, fetchImpl)).toEqual({ kind: "wrong-tenant" });
  });

  it("maps the API's own 404 to not published, and any other 404 to failed", async () => {
    const ours = reply(404, { error: { code: "tenant_not_found", message: "x" } });
    expect(await loadStart(harbor, endpoint, ours)).toEqual({ kind: "not-published" });
    const proxy = reply(404, { message: "Not Found" });
    expect(await loadStart(harbor, endpoint, proxy)).toEqual({ kind: "failed" });
  });

  it("shows not ready for a tenant without a brand", async () => {
    const fetchImpl = reply(200, { tenant: { slug: "demo-harbor", name: "Demo Harbor Charters" } });
    expect((await loadStart(harbor, endpoint, fetchImpl)).kind).toBe("not-ready");
  });

  it("fails on a server error, a broken body, or a network error", async () => {
    expect(await loadStart(harbor, endpoint, reply(500, {}))).toEqual({ kind: "failed" });
    const broken = reply(200, { tenant: { slug: "demo-harbor", name: "x" }, brand: { name: 1 } });
    expect(await loadStart(harbor, endpoint, broken)).toEqual({ kind: "failed" });
    const offline = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    expect(await loadStart(harbor, endpoint, offline)).toEqual({ kind: "failed" });
  });
});

describe("loadTrips", () => {
  it("asks for the range and party, and fails on a broken list", async () => {
    const fetchImpl = reply(200, { trips: [{ tripId: "nope" }] });
    expect(await loadTrips(endpoint, { from: "2026-11-07", to: "2026-12-05" }, fetchImpl)).toEqual({
      kind: "failed",
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      "https://api.tidegrid.us/v1/public/trips?from=2026-11-07&to=2026-12-05&party=1",
    );
  });

  it("returns an empty list as ok", async () => {
    const fetchImpl = reply(200, { trips: [] });
    expect(await loadTrips(endpoint, { from: "2026-11-07", to: "2026-12-05" }, fetchImpl)).toEqual({
      kind: "ok",
      trips: [],
    });
  });
});

describe("isoDate", () => {
  it("adds days across a month end", () => {
    expect(isoDate(new Date("2026-11-30T23:00:00Z"), 1)).toBe("2026-12-01");
    expect(isoDate(new Date("2026-11-01T00:00:00Z"), -1)).toBe("2026-10-31");
  });
});
