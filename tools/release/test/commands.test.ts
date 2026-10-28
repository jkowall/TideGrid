import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { assertDisableable } from "../src/commands/hostname-disable.ts";
import { runIsolation } from "../src/commands/isolation.ts";
import { runLastSeat } from "../src/commands/last-seat.ts";
import { checkAccountRef } from "../src/commands/payment-account.ts";
import { generatable } from "../src/commands/secrets.ts";
import { checkTestKey } from "../src/commands/stripe-smoke.ts";
import { parseHosts, profileFor } from "../src/http.ts";
import { loadJournal, saveJournal } from "../src/journal.ts";
import { fakeApi } from "./fake-api.ts";
import { fakeDeps, headSha, providerExecs, recordingSql } from "./helpers.ts";

const preview = () =>
  profileFor(
    "preview",
    "https://api.tidegrid.us",
    parseHosts("demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us"),
  );

describe("last-seat against a stand-in API", () => {
  it("finds exactly one winner per race and stays inside the budget", async () => {
    const api = fakeApi();
    const { deps } = fakeDeps({ fetch: api.fetch });
    const results = await runLastSeat(deps, preview());
    expect(results.map((r) => [r.tenant, r.outcome])).toEqual([
      ["demo-reef", "pass"],
      ["demo-harbor", "pass"],
    ]);
    expect(results[0]?.statuses).toEqual({ "201 opened": 1, "409 insufficient_capacity": 7 });
    expect(api.counts.get("demo-reef")).toBe(23);
    expect(api.counts.get("demo-harbor")).toBe(17);
  });

  it("reports the first 429 as rate-limited, never as oversell or fail", async () => {
    const api = fakeApi({ limit: 10 });
    const { deps } = fakeDeps({ fetch: api.fetch });
    const results = await runLastSeat(deps, preview());
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("rate-limited");
  });

  it("refuses the live run without the A5 gate", async () => {
    const { deps, fetches } = fakeDeps({ answers: ["api.tidegrid.us"] });
    expect(
      await main(
        [
          "last-seat",
          "--profile",
          "preview",
          "--api",
          "https://api.tidegrid.us",
          "--hosts",
          "demo-reef.book.tidegrid.us",
          "--live",
          "--go",
          "A4",
        ],
        deps,
      ),
    ).toBe(3);
    expect(fetches).toEqual([]);
  });
});

describe("isolation, public half", () => {
  it("every cross-tenant read answers 404 with no B data", async () => {
    const api = fakeApi();
    const { deps } = fakeDeps({ fetch: api.fetch });
    const probes = await runIsolation(deps, preview());
    expect(probes.map((p) => [p.probe, p.status, p.leak])).toEqual([
      ["B trip offer", 404, false],
      ["B quote", 404, false],
      ["B checkout", 404, false],
    ]);
    expect(api.counts.get("demo-reef")).toBe(3);
    expect(api.counts.get("demo-harbor") ?? 0).toBe(0);
  });
});

describe("db: unsafe inputs refuse", () => {
  const liveDb = { NEON_DATABASE_URL: "postgresql://o:p@ep-main.neon.tech/neondb" };
  for (const name of [
    "TIDEGRID_EPHEMERAL_DB",
    "TIDEGRID_APP_PASSWORD",
    "SEED_LOCAL_HOSTNAMES",
    "E2E_ADMIN_DATABASE_URL",
    "SEED_DEMO_BOOKINGS",
  ]) {
    it(`refuses with ${name} in the shell`, async () => {
      const { deps, execs } = fakeDeps({ env: { ...liveDb, [name]: "1" } });
      expect(await main(["db", "migrate", "--live", "--go", "A1"], deps)).toBe(3);
      expect(providerExecs(execs)).toEqual([]);
    });
  }

  it("allows SEED_DEMO_BOOKINGS only under --d14 b", async () => {
    const { deps } = fakeDeps({ env: { ...liveDb, SEED_DEMO_BOOKINGS: "1" }, tty: false });
    expect(await main(["db", "seed", "--d14", "b"], deps)).toBe(0);
  });

  it("refuses an exported DATABASE_URL for a live run", async () => {
    const { deps } = fakeDeps({
      env: { ...liveDb, DATABASE_URL: "postgres://x" },
      answers: ["ep-main.neon.tech"],
    });
    expect(await main(["db", "status", "--live", "--go", "A1"], deps)).toBe(3);
  });

  it("maps --url-env to DATABASE_URL in the child only, on a live run", async () => {
    const { deps, execs } = fakeDeps({
      env: liveDb,
      answers: ["ep-main.neon.tech"],
      exec: (c) => (c.args.includes("migrate") ? { code: 0, stdout: "" } : undefined),
    });
    expect(await main(["db", "migrate", "--live", "--go", "A1"], deps)).toBe(0);
    const run = execs.find((e) => e.args.includes("migrate"));
    expect(run?.options.env.DATABASE_URL).toBe(liveDb.NEON_DATABASE_URL);
    expect(run?.options.env.NEON_DATABASE_URL).toBeUndefined();
    expect(run?.options.stdio).toBe("inherit");
  });

  it("db platform refuses an unknown slug, a missing step 6, or an unapproved C4", async () => {
    const answers = ["ep-main.neon.tech", "demo-harbor", "demo.tidegrid.us"];
    const bad = fakeDeps({
      env: liveDb,
      answers: ["ep-main.neon.tech", "demo-nowhere", "demo.tidegrid.us"],
    });
    expect(await main(["db", "platform", "demo-nowhere", "--live", "--go", "A10"], bad.deps)).toBe(
      3,
    );

    const noStep6 = fakeDeps({ env: liveDb, answers });
    expect(
      await main(["db", "platform", "demo-harbor", "--live", "--go", "A10"], noStep6.deps),
    ).toBe(3);
    expect(noStep6.printed.join("\n")).toMatch(/step 6/);

    const sql = recordingSql();
    sql.answers["from public.tenants where slug"] = [
      { id: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01" },
    ];
    const ready = fakeDeps({ env: liveDb, answers, sql: () => sql.client });
    const j = loadJournal(ready.deps);
    j.entries.push({ at: "2026-11-01T16:00:00Z", phase: "p6", step: "last-seat", result: "done" });
    saveJournal(ready.deps, j);
    expect(await main(["db", "platform", "demo-harbor", "--live", "--go", "A10"], ready.deps)).toBe(
      3,
    );
    expect(ready.printed.join("\n")).toMatch(/C4/);
    const k = loadJournal(ready.deps);
    k.approved.push({ sha: headSha, tree: "t", gate: "A10", at: "2026-11-01T17:00:00Z" });
    saveJournal(ready.deps, k);
    const go = fakeDeps({ env: liveDb, answers, sql: () => sql.client });
    go.deps.stateDir = ready.deps.stateDir;
    expect(await main(["db", "platform", "demo-harbor", "--live", "--go", "A10"], go.deps)).toBe(0);
    expect(sql.statements.map((s) => s.text).join("\n")).toMatch(
      /'platform', 'active'[\s\S]*hostname\.platform_added/,
    );
  });
});

describe("payment-account and hostname-disable refuse unsafe inputs", () => {
  it("takes a real-looking Stripe account id only", () => {
    expect(() => checkAccountRef(undefined, "STRIPE_ACCT_DEMO_HARBOR")).toThrow(/not set/);
    expect(() => checkAccountRef("acct_fake_demo_harbor", "X")).toThrow();
    expect(() => checkAccountRef("cus_123", "X")).toThrow(/acct_/);
    expect(checkAccountRef("acct_1AbC", "X")).toBe("acct_1AbC");
  });

  it("never prints the account id", async () => {
    const sql = recordingSql();
    sql.answers["from public.tenants where slug"] = [
      { id: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01" },
    ];
    const { deps, printed } = fakeDeps({
      env: {
        NEON_DATABASE_URL: "postgresql://o:p@ep-main.neon.tech/neondb",
        STRIPE_ACCT_DEMO_HARBOR: "acct_1SecretHarbor",
      },
      answers: ["ep-main.neon.tech", "demo-harbor"],
      sql: () => sql.client,
    });
    expect(
      await main(
        ["payment-account", "set", "demo-harbor", "stripe", "--live", "--go", "A12"],
        deps,
      ),
    ).toBe(0);
    expect(printed.join("\n")).not.toContain("SecretHarbor");
    expect(JSON.stringify(loadJournal(deps))).not.toContain("SecretHarbor");
    expect(sql.statements.some((s) => s.params.includes("acct_1SecretHarbor"))).toBe(true);
  });

  it("refuses to disable a preview or platform name, or a malformed one", () => {
    for (const h of [
      "demo-harbor.book.tidegrid.us",
      "demo-reef.book.tidegrid.us",
      "demo.tidegrid.us",
      "x.tidegrid.us",
      "oneword",
    ]) {
      expect(() => assertDisableable(h)).toThrow();
    }
    expect(() => assertDisableable("book.owner-test-domain.com")).not.toThrow();
  });

  it("refuses a hostname whose row is not custom", async () => {
    const sql = recordingSql();
    sql.answers["from public.tenant_hostnames h"] = [{ kind: "preview", slug: "demo-harbor" }];
    const { deps, execs } = fakeDeps({
      env: { NEON_DATABASE_URL: "postgresql://o:p@ep-main.neon.tech/neondb" },
      answers: ["ep-main.neon.tech", "book.owner-test-domain.com"],
      sql: () => sql.client,
    });
    expect(
      await main(
        ["hostname-disable", "demo-harbor", "book.owner-test-domain.com", "--live", "--go", "A18"],
        deps,
      ),
    ).toBe(3);
    expect(execs.filter((e) => e.args.includes("disable"))).toEqual([]);
  });
});

describe("secrets", () => {
  it("generates only the fake webhook secret, through a pipe nov1 never reads", async () => {
    expect(generatable).toEqual(["FAKE_PAYMENT_WEBHOOK_SECRET"]);
    const { deps, execs } = fakeDeps({ answers: ["tidegrid-api", "FAKE_PAYMENT_WEBHOOK_SECRET"] });
    const j = loadJournal(deps);
    j.approved.push({ sha: headSha, tree: "t", gate: "P0.1", at: "x" });
    saveJournal(deps, j);
    expect(
      await main(
        ["secrets", "preview", "--generate", "FAKE_PAYMENT_WEBHOOK_SECRET", "--live", "--go", "A2"],
        deps,
      ),
    ).toBe(0);
    const sh = execs.find((e) => e.cmd === "sh");
    expect(sh?.args).toEqual([
      "-c",
      "openssl rand -hex 32 | pnpm exec wrangler secret put FAKE_PAYMENT_WEBHOOK_SECRET",
    ]);
    expect(sh?.options.stdio).toBe("inherit");
  });

  it("refuses a secret change after a code rollback (10215) and names the versions path", async () => {
    const { deps, execs, printed } = fakeDeps({
      answers: ["tidegrid-api", "EMAIL_ALLOWED_RECIPIENTS"],
    });
    const j = loadJournal(deps);
    j.approved.push({ sha: headSha, tree: "t", gate: "P0.1", at: "x" });
    j.flags.rolledBack = ["api"];
    saveJournal(deps, j);
    expect(
      await main(
        ["secrets", "email", "--delete", "EMAIL_ALLOWED_RECIPIENTS", "--live", "--go", "A7"],
        deps,
      ),
    ).toBe(3);
    expect(printed.join("\n")).toMatch(/versions secret put/);
    expect(execs.filter((e) => e.args.includes("secret"))).toEqual([]);
  });

  it("refuses a name outside the set", async () => {
    const { deps } = fakeDeps();
    expect(
      await main(
        ["secrets", "preview", "--put", "STRIPE_SECRET_KEY", "--live", "--go", "A2"],
        deps,
      ),
    ).toBe(3);
  });
});

describe("stripe-smoke key rules", () => {
  it("takes test keys only", () => {
    expect(checkTestKey("sk_test_abc")).toBe("sk_test_abc");
    expect(checkTestKey("rk_test_abc")).toBe("rk_test_abc");
    for (const k of ["sk_live_abc", "rk_live_abc", "pk_test_abc", "", undefined])
      expect(() => checkTestKey(k)).toThrow();
  });

  it("refuses a live key before any call", async () => {
    const { deps, fetches, execs } = fakeDeps({
      env: { STRIPE_SECRET_KEY: "sk_live_abc" },
      answers: ["test mode", "demo-harbor"],
    });
    expect(await main(["stripe-smoke", "--live", "--go", "A11"], deps)).toBe(3);
    expect(fetches).toEqual([]);
    expect(execs).toEqual([]);
  });
});
