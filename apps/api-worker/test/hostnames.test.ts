import { createExecutionContext, env, SELF } from "cloudflare:test";
import { createFakeHostnameProvider } from "@tidegrid/domain-hostnames";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { Bindings } from "../src/env.ts";
import { PreflightProjection, preflightProjection } from "../src/hostnames/cors.ts";
import {
  GUEST_HOST_MAX_ENTRIES,
  GUEST_HOST_TTL_MS,
  GUEST_KNOWN_MAX_ENTRIES,
  GUEST_KNOWN_TTL_MS,
  GUEST_MISS_BUDGET,
  GUEST_MISS_WINDOW_MS,
  type GuestHostLookup,
  guestHostProjection,
  guestKnownHosts,
  guestMissBudget,
  LookupBudget,
  resolveGuestHost,
} from "../src/hostnames/guest-gateway.ts";
import { TtlProjection } from "../src/hostnames/projection.ts";
import { hostnameProvider, hostnameSettings } from "../src/hostnames.ts";
import { GuestGateway } from "../src/index.ts";

const base = env as unknown as Bindings;
const zone = "0123456789abcdef0123456789abcdef";

describe("custom hostname provider selection (G2.14b)", () => {
  it("is off unless a provider is named", () => {
    expect(hostnameSettings({ ...base })).toEqual({
      kind: "off",
      reason: "unset",
    });
    expect(hostnameProvider({ ...base })).toBeNull();
  });

  it("accepts the fake only in local development and never beside a SaaS zone", () => {
    expect(hostnameSettings({ ...base, ENVIRONMENT: "local", HOSTNAME_PROVIDER: "fake" })).toEqual({
      kind: "fake",
    });
    for (const environment of ["preview", "staging", "production"] as const) {
      expect(
        hostnameSettings({ ...base, ENVIRONMENT: environment, HOSTNAME_PROVIDER: "fake" }),
      ).toEqual({ kind: "refused", reason: "fake_outside_local" });
    }
    for (const environment of ["local", "preview", "production"] as const) {
      expect(
        hostnameSettings({
          ...base,
          ENVIRONMENT: environment,
          HOSTNAME_PROVIDER: "fake",
          CF_SAAS_ZONE_ID: zone,
        }),
      ).toEqual({ kind: "refused", reason: "fake_with_zone" });
    }
    expect(hostnameSettings({ ...base, HOSTNAME_PROVIDER: "stripe" })).toEqual({
      kind: "refused",
      reason: "unknown_provider",
    });
  });

  it("reads only an injected fake, because a fake built in a Worker knows no hostname", () => {
    const local = { ...base, ENVIRONMENT: "local" as const, HOSTNAME_PROVIDER: "fake" };
    expect(hostnameProvider(local)).toBeNull();
    const fake = createFakeHostnameProvider();
    expect(hostnameProvider(local, fake)).toBe(fake);
    expect(hostnameProvider({ ...local, ENVIRONMENT: "preview" }, fake)).toBeNull();
  });

  it("needs the zone and the token for Cloudflare for SaaS", () => {
    const saas = { ...base, ENVIRONMENT: "preview" as const, HOSTNAME_PROVIDER: "cloudflare_saas" };
    expect(hostnameSettings(saas)).toEqual({ kind: "off", reason: "zone_missing" });
    expect(hostnameSettings({ ...saas, CF_SAAS_ZONE_ID: zone })).toEqual({
      kind: "off",
      reason: "token_missing",
    });
    const on = { ...saas, CF_SAAS_ZONE_ID: zone, CF_SAAS_API_TOKEN: "synthetic-token" };
    expect(hostnameSettings(on)).toMatchObject({
      kind: "cloudflare_saas",
      routingTarget: "customers.tidegrid.us",
    });
    expect(hostnameProvider(on)?.name).toBe("cloudflare_saas");
  });
});

describe("the preflight projection (G2.14b)", () => {
  it("keeps at most its capacity, least recently used out first", () => {
    const cache = new PreflightProjection(3, 30_000);
    for (const o of ["https://a.example.com", "https://b.example.com", "https://c.example.com"]) {
      cache.set(o, true, 0);
    }
    expect(cache.get("https://a.example.com", 1)).toBe(true);
    cache.set("https://d.example.com", false, 1);
    expect(cache.size).toBe(3);
    expect(cache.get("https://b.example.com", 2)).toBeUndefined();
    expect(cache.get("https://a.example.com", 2)).toBe(true);
    expect(cache.get("https://d.example.com", 2)).toBe(false);
  });

  it("forgets positives and negatives alike after 30 seconds", () => {
    const cache = new PreflightProjection();
    cache.set("https://a.example.com", true, 0);
    cache.set("https://b.example.com", false, 0);
    expect(cache.get("https://a.example.com", 29_999)).toBe(true);
    expect(cache.get("https://a.example.com", 30_000)).toBeUndefined();
    expect(cache.get("https://b.example.com", 30_001)).toBeUndefined();
  });

  it("stays capped under a flood of unique origins", () => {
    const cache = new PreflightProjection();
    for (let i = 0; i < 5_000; i++) cache.set(`https://h${i}.example.com`, false, 0);
    expect(cache.size).toBe(1_000);
  });
});

describe("preflight flood (G2.14b)", () => {
  it("limits lookups per address before any database call, and never for an unparsable origin", async () => {
    const app = createApp();
    const keys: string[] = [];
    const limited = {
      ...base,
      PUBLIC_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    preflightProjection.clear();
    const preflight = (origin: string) =>
      app.request(
        "https://api.test/v1/public/quotes",
        {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "POST",
            "cf-connecting-ip": "203.0.113.9",
          },
        },
        limited,
        createExecutionContext(),
      );
    // No database is configured: a lookup would fail. The limiter refuses first.
    for (let i = 0; i < 50; i++) {
      const res = await preflight(`https://flood-${i}.example.com`);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(keys).toHaveLength(50);
    expect(new Set(keys)).toEqual(new Set(["cors:203.0.113.9"]));
    // Unparsable origins never reach the limiter or the database.
    for (const origin of ["http://10.0.0.1", "https://x.example.com:443", "null"]) {
      await preflight(origin);
    }
    expect(keys).toHaveLength(50);
    expect(preflightProjection.size).toBe(0);
  });
});

describe("simple-request flood (G2.14b, R5)", () => {
  it("limits CORS lookups for simple requests too, even on paths that do not exist", async () => {
    const app = createApp();
    const keys: string[] = [];
    const limited = {
      ...base,
      PUBLIC_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    preflightProjection.clear();
    for (let i = 0; i < 20; i++) {
      // No database is configured: a lookup would answer 500. The limiter refuses first.
      const res = await app.request(
        "https://api.test/v1/public/does-not-exist",
        {
          headers: { origin: `https://simple-${i}.example.com`, "cf-connecting-ip": "203.0.113.7" },
        },
        limited,
        createExecutionContext(),
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(keys).toEqual(Array.from({ length: 20 }, () => "cors:203.0.113.7"));
  });
});

describe("the PUBLIC_CORS rollback (G2.14b, R6)", () => {
  it("keeps only the static allowlist unless PUBLIC_CORS is dynamic", async () => {
    const app = createApp();
    for (const PUBLIC_CORS of [undefined, "static", "on", "Dynamic"]) {
      const env = { ...base } as Bindings;
      if (PUBLIC_CORS === undefined) delete env.PUBLIC_CORS;
      else env.PUBLIC_CORS = PUBLIC_CORS;
      const res = await app.request(
        "https://api.test/v1/public/tenant",
        {
          method: "OPTIONS",
          headers: { origin: "https://book.example.com", "access-control-request-method": "GET" },
        },
        env,
        createExecutionContext(),
      );
      expect({ PUBLIC_CORS, acao: res.headers.get("access-control-allow-origin") }).toEqual({
        PUBLIC_CORS,
        acao: null,
      });
    }
    const allowlisted = await app.request(
      "https://api.test/v1/public/tenant",
      {
        method: "OPTIONS",
        headers: { origin: "https://guest.test", "access-control-request-method": "GET" },
      },
      { ...base, PUBLIC_CORS: "static" },
      createExecutionContext(),
    );
    expect(allowlisted.headers.get("access-control-allow-origin")).toBe("https://guest.test");
  });
});

describe("public CORS without a database (G2.14b)", () => {
  async function call(path: string, origin: string, method = "GET") {
    return SELF.fetch(`https://api.test${path}`, {
      method,
      headers: {
        origin,
        ...(method === "OPTIONS"
          ? {
              "access-control-request-method": "POST",
              "access-control-request-headers": "content-type",
            }
          : {}),
      },
    });
  }

  it("answers a rejected origin's bootstrap with the shared 404, no grant, and Vary", async () => {
    for (const origin of [
      "http://10.0.0.1",
      "null",
      "https://book.example.com.",
      "https://book.example.com:443",
      "http://book.example.com",
      "https://Book.Example.com",
      "https://xn--bcher-kva.example.com",
      "https://user@book.example.com",
    ]) {
      const res = await call("/v1/public/tenant", origin);
      expect({ origin, status: res.status }).toEqual({ origin, status: 404 });
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "tenant_not_found",
      );
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("refuses a rejected origin on every other public route before any database call", async () => {
    for (const path of [
      "/v1/public/trips?from=2099-01-01&to=2000-01-01",
      "/v1/public/trips?party=nope",
      "/v1/public/quotes/00000000-0000-4000-8000-000000000000",
    ]) {
      const res = await call(path, "http://10.0.0.1");
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
    }
  });

  it("answers preflights with Vary and no grant for a rejected origin", async () => {
    for (const path of ["/v1/public/tenant", "/v1/public/quotes"]) {
      const res = await call(path, "https://book.example.com:443", "OPTIONS");
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
    }
  });

  it("lets any strictly parsed origin preflight the bootstrap, never with credentials", async () => {
    const res = await call("/v1/public/tenant", "https://book.example.com", "OPTIONS");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://book.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
  });

  it("keeps staff routes on their own allowlist", async () => {
    const res = await call("/v1/staff/memberships", "https://book.example.com", "OPTIONS");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GuestGateway (G2.14b)", () => {
  beforeEach(() => guestHostProjection.clear());
  afterEach(() => guestHostProjection.clear());

  it("exposes one method and no fetch, so no app route is reachable through it", () => {
    expect(Object.getOwnPropertyNames(GuestGateway.prototype).sort()).toEqual([
      "constructor",
      "resolveHost",
    ]);
    const gateway = new GuestGateway(createExecutionContext(), env);
    expect((gateway as unknown as { fetch?: unknown }).fetch).toBeUndefined();
  });

  it("parses the host itself and answers a definite miss without the database", async () => {
    const gateway = new GuestGateway(createExecutionContext(), env);
    for (const host of [
      "Book.Example.com",
      "book.example.com.",
      "https://book.example.com",
      "book.example.com:443",
      "10.0.0.1",
      "localhost",
      "xn--bcher-kva.example.com",
      "",
      42,
      null,
      { toString: () => "book.example.com" },
    ]) {
      expect(await gateway.resolveHost(host)).toEqual({ kind: "miss" });
    }
    const preview = new GuestGateway(createExecutionContext(), {
      ...env,
      ENVIRONMENT: "preview",
    } as never);
    expect(await preview.resolveHost("demo-harbor.book.localhost")).toEqual({ kind: "miss" });
  });

  it("throws on an accepted host when the database is unreachable, which is not a miss", async () => {
    const gateway = new GuestGateway(createExecutionContext(), env);
    await expect(gateway.resolveHost("demo-harbor.book.tidegrid.us")).rejects.toThrow(
      /database_unconfigured/,
    );
    // A failure is never kept.
    expect(guestHostProjection.size).toBe(0);
  });
});

describe("the guest host projection (G2.14b-live pre-release note)", () => {
  beforeEach(() => guestHostProjection.clear());
  afterEach(() => guestHostProjection.clear());
  const host = "demo-harbor.book.tidegrid.us";
  const experience = { tenant: { slug: "demo-harbor", name: "Demo Harbor" } };
  const keyFor = (environment: string | undefined) => `${environment ?? ""}|${host}`;

  it("keeps found answers for 10 seconds and at most 1,000 hosts", () => {
    expect(GUEST_HOST_TTL_MS).toBe(10_000);
    expect(GUEST_HOST_MAX_ENTRIES).toBe(1_000);
    expect(guestHostProjection.ttlMs).toBe(GUEST_HOST_TTL_MS);
    expect(guestHostProjection.maxEntries).toBe(GUEST_HOST_MAX_ENTRIES);
    const cache = new TtlProjection<number>(GUEST_HOST_MAX_ENTRIES, GUEST_HOST_TTL_MS);
    for (let i = 0; i < 5_000; i++) cache.set(`h${i}.example.com`, i, 0);
    expect(cache.size).toBe(1_000);
    expect(cache.get("h4999.example.com", 9_999)).toBe(4_999);
    expect(cache.get("h4999.example.com", 10_000)).toBeUndefined();
  });

  it("answers a kept host without the database, and only in its own environment", async () => {
    // The test environment has no database, so any read would throw.
    guestHostProjection.set(keyFor(base.ENVIRONMENT), experience, Date.now());
    const gateway = new GuestGateway(createExecutionContext(), env);
    expect(await gateway.resolveHost(host)).toEqual({ kind: "found", experience });
    const other = base.ENVIRONMENT === "preview" ? "staging" : "preview";
    const elsewhere = new GuestGateway(createExecutionContext(), {
      ...env,
      ENVIRONMENT: other,
    } as never);
    await expect(elsewhere.resolveHost(host)).rejects.toThrow(/database_unconfigured/);
  });

  it("reads afresh once the kept answer is 10 seconds old", async () => {
    guestHostProjection.set(keyFor(base.ENVIRONMENT), experience, Date.now() - GUEST_HOST_TTL_MS);
    const gateway = new GuestGateway(createExecutionContext(), env);
    await expect(gateway.resolveHost(host)).rejects.toThrow(/database_unconfigured/);
    expect(guestHostProjection.size).toBe(0);
  });

  it("never consults it for a host the strict rules refuse", async () => {
    // Even a kept entry under the raw, non-canonical spelling cannot answer.
    guestHostProjection.set(
      `${base.ENVIRONMENT ?? ""}|Demo-Harbor.book.tidegrid.us`,
      experience,
      Date.now(),
    );
    const gateway = new GuestGateway(createExecutionContext(), env);
    expect(await gateway.resolveHost("Demo-Harbor.book.tidegrid.us")).toEqual({ kind: "miss" });
  });
});

describe("the guest miss budget (G2.14b-live, D1 to D3)", () => {
  const reset = () => {
    guestHostProjection.clear();
    guestKnownHosts.clear();
    guestMissBudget.clear();
  };
  beforeEach(reset);
  afterEach(reset);

  // A database URL that is never dialed: every read goes through `lookup`.
  const withDb = { ...base, DATABASE_URL: "postgres://unit:unit@db.invalid:5432/none" } as Bindings;
  const experience = { tenant: { slug: "demo-harbor", name: "Demo Harbor" } };
  const live = "demo-harbor.book.tidegrid.us";

  /** A lookup that counts its reads and answers from a mutable table. */
  function fakeDb(answers: Record<string, "found" | "withheld" | "throws"> = {}) {
    const reads: string[] = [];
    const lookup: GuestHostLookup = async (_env, host) => {
      reads.push(host);
      // Yield, so concurrent callers really overlap.
      await new Promise((r) => setTimeout(r, 1));
      const answer = answers[host];
      if (answer === "throws") throw new Error("database down");
      if (answer === "withheld") {
        return { kind: "withheld", tenantId: "t", version: 1, reason: "BrandConfigInvalid" };
      }
      if (answer === "found") return { kind: "found", tenantId: "t", experience };
      return { kind: "miss" };
    };
    return { reads, lookup, answers };
  }

  it("is 20 lookups per 10 seconds per isolate, with no binding", () => {
    expect(GUEST_MISS_BUDGET).toBe(20);
    expect(GUEST_MISS_WINDOW_MS).toBe(10_000);
    expect(guestMissBudget.capacity).toBe(GUEST_MISS_BUDGET);
    expect(guestMissBudget.windowMs).toBe(GUEST_MISS_WINDOW_MS);
    expect(GUEST_KNOWN_TTL_MS).toBe(600_000);
    expect(GUEST_KNOWN_MAX_ENTRIES).toBe(1_000);
    // The cache defaults the owner confirmed are unchanged.
    expect(GUEST_HOST_TTL_MS).toBe(10_000);
    expect(GUEST_HOST_MAX_ENTRIES).toBe(1_000);
  });

  it("never lets a 10-second span open more than its capacity of spent lookups", () => {
    const budget = new LookupBudget(3, 10_000);
    for (let i = 0; i < 3; i++) expect(budget.take(0)).toBe(true);
    // Three lookups under way hold every token.
    expect(budget.take(0)).toBe(false);
    for (let i = 0; i < 3; i++) budget.settle(0, true);
    expect(budget.take(9_999)).toBe(false);
    expect(budget.available(9_999)).toBe(0);
    // Each token comes back 10 seconds after its lookup began.
    expect(budget.available(10_000)).toBe(3);
    expect(budget.take(10_000)).toBe(true);
    // A lookup that is not spent gives its token back at once.
    budget.settle(10_000, false);
    expect(budget.available(10_000)).toBe(3);
    // Staggered: one spent at 1 s and two at 5 s free at 11 s and 15 s.
    budget.take(1_000);
    budget.settle(1_000, true);
    budget.take(5_000);
    budget.take(5_000);
    budget.settle(5_000, true);
    budget.settle(5_000, true);
    expect(budget.take(10_999)).toBe(false);
    expect(budget.available(11_000)).toBe(1);
    expect(budget.available(15_000)).toBe(3);
  });

  it("opens at most 20 lookups for a flood of distinct unknown hosts, and none is a miss past that", async () => {
    const db = fakeDb();
    const flood = Array.from({ length: 1_000 }, (_, i) => `flood-${i}.example.com`);
    // All at once, so lookups under way must hold their tokens.
    const answers = await Promise.all(flood.map((h) => resolveGuestHost(withDb, h, db.lookup)));
    expect(db.reads).toHaveLength(GUEST_MISS_BUDGET);
    const kinds = answers.map((a) => a.kind);
    expect(kinds.filter((k) => k === "miss")).toHaveLength(GUEST_MISS_BUDGET);
    expect(kinds.filter((k) => k === "limited")).toHaveLength(1_000 - GUEST_MISS_BUDGET);
    // One after another, too: still no read.
    for (let i = 0; i < 100; i++) {
      expect(await resolveGuestHost(withDb, `late-${i}.example.com`, db.lookup)).toEqual({
        kind: "limited",
      });
    }
    expect(db.reads).toHaveLength(GUEST_MISS_BUDGET);
    // Nothing is kept for a miss or a limited answer.
    expect(guestHostProjection.size).toBe(0);
    expect(guestKnownHosts.size).toBe(0);
  });

  it("serves a definite miss only from a lookup, and a limited host reads once a token is free", async () => {
    const db = fakeDb();
    for (let i = 0; i < GUEST_MISS_BUDGET; i++) {
      await resolveGuestHost(withDb, `spend-${i}.example.com`, db.lookup);
    }
    expect(await resolveGuestHost(withDb, "nobody.example.com", db.lookup)).toEqual({
      kind: "limited",
    });
    expect(db.reads).not.toContain("nobody.example.com");
    // The window passes (simulated by clearing the budget): the next call reads and misses.
    guestMissBudget.clear();
    expect(await resolveGuestHost(withDb, "nobody.example.com", db.lookup)).toEqual({
      kind: "miss",
    });
    expect(db.reads.at(-1)).toBe("nobody.example.com");
  });

  it("gives the token back for a found answer and keeps it for a withheld brand or a failure", async () => {
    const db = fakeDb({
      [live]: "found",
      "withheld.example.com": "withheld",
      "broken.example.com": "throws",
    });
    expect((await resolveGuestHost(withDb, live, db.lookup)).kind).toBe("found");
    expect(guestMissBudget.available(Date.now())).toBe(GUEST_MISS_BUDGET);
    expect(await resolveGuestHost(withDb, "withheld.example.com", db.lookup)).toEqual({
      kind: "withheld",
    });
    expect(guestMissBudget.available(Date.now())).toBe(GUEST_MISS_BUDGET - 1);
    await expect(resolveGuestHost(withDb, "broken.example.com", db.lookup)).rejects.toThrow(
      /database down/,
    );
    expect(guestMissBudget.available(Date.now())).toBe(GUEST_MISS_BUDGET - 2);
    // A withheld or failed host is never kept, as found or as known.
    expect(guestHostProjection.size).toBe(1);
    expect(guestKnownHosts.size).toBe(1);
    // Spent tokens bound a flood of a withheld host too.
    for (let i = 0; i < 50; i++) await resolveGuestHost(withDb, "withheld.example.com", db.lookup);
    expect(db.reads.filter((h) => h === "withheld.example.com")).toHaveLength(
      GUEST_MISS_BUDGET - 1,
    );
  });

  it("keeps found answers for 10 seconds unchanged, and lets a known host past a spent budget", async () => {
    const db = fakeDb({ [live]: "found" });
    const first = await resolveGuestHost(withDb, live, db.lookup);
    expect(first).toEqual({ kind: "found", experience });
    // Kept: the next call reads nothing.
    expect(await resolveGuestHost(withDb, live, db.lookup)).toEqual(first);
    expect(db.reads).toEqual([live]);
    // A flood spends the budget.
    for (let i = 0; i < 200; i++) {
      await resolveGuestHost(withDb, `flood-${i}.example.com`, db.lookup);
    }
    expect(guestMissBudget.available(Date.now())).toBe(0);
    // The kept answer expires: the known host reads afresh, past the spent budget.
    const key = `${base.ENVIRONMENT ?? ""}|${live}`;
    guestHostProjection.set(key, experience, Date.now() - GUEST_HOST_TTL_MS);
    expect(await resolveGuestHost(withDb, live, db.lookup)).toEqual(first);
    expect(db.reads.filter((h) => h === live)).toHaveLength(2);
  });

  it("serves the kill switch to a disabled known host at once, then budgets it like any other", async () => {
    const db = fakeDb({ [live]: "found" });
    await resolveGuestHost(withDb, live, db.lookup);
    for (let i = 0; i < 200; i++) {
      await resolveGuestHost(withDb, `flood-${i}.example.com`, db.lookup);
    }
    // The operator's host is disabled and its kept answer expires.
    delete db.answers[live];
    guestHostProjection.clear();
    expect(await resolveGuestHost(withDb, live, db.lookup)).toEqual({ kind: "miss" });
    expect(guestKnownHosts.size).toBe(0);
    // No longer known: with the budget spent, it is limited, never found.
    expect(await resolveGuestHost(withDb, live, db.lookup)).toEqual({ kind: "limited" });
    expect(guestHostProjection.size).toBe(0);
  });

  it("drops a known host on a database failure, so an outage is budgeted too", async () => {
    const db = fakeDb({ [live]: "found" });
    await resolveGuestHost(withDb, live, db.lookup);
    expect(guestKnownHosts.size).toBe(1);
    db.answers[live] = "throws";
    guestHostProjection.clear();
    await expect(resolveGuestHost(withDb, live, db.lookup)).rejects.toThrow(/database down/);
    expect(guestKnownHosts.size).toBe(0);
    // Known hosts skip the budget, so that failure spent nothing.
    expect(guestMissBudget.available(Date.now())).toBe(GUEST_MISS_BUDGET);
    for (let i = 0; i < 50; i++) {
      await resolveGuestHost(withDb, live, db.lookup).catch(() => undefined);
    }
    // One read as a known host, then at most the budget.
    expect(db.reads.filter((h) => h === live)).toHaveLength(2 + GUEST_MISS_BUDGET);
  });

  it("resolves a newly activated host on its next lookup, since no miss is kept (D2)", async () => {
    const db = fakeDb();
    const fresh = "new-operator.example.com";
    expect(await resolveGuestHost(withDb, fresh, db.lookup)).toEqual({ kind: "miss" });
    db.answers[fresh] = "found";
    expect(await resolveGuestHost(withDb, fresh, db.lookup)).toEqual({ kind: "found", experience });
    expect(db.reads).toEqual([fresh, fresh]);
  });

  it("spends nothing on a host the strict rules refuse, or without a database", async () => {
    const db = fakeDb();
    for (let i = 0; i < 100; i++) {
      expect(await resolveGuestHost(withDb, `Flood-${i}.example.com`, db.lookup)).toEqual({
        kind: "miss",
      });
    }
    await expect(resolveGuestHost(base, "nobody.example.com", db.lookup)).rejects.toThrow(
      /database_unconfigured/,
    );
    expect(db.reads).toHaveLength(0);
    expect(guestMissBudget.available(Date.now())).toBe(GUEST_MISS_BUDGET);
  });
});
