import { describe, expect, it } from "vitest";
import { renderEvidence } from "../src/commands/evidence.ts";
import { budget, publicLimitPerMinute, racePlans, racers } from "../src/commands/last-seat.ts";
import { healthExpect, smokeProfiles } from "../src/commands/smoke.ts";
import { emptyJournal } from "../src/journal.ts";
import { type Configs, loadConfigs, parseJsonc, phaseGuard } from "../src/phase.ts";
import { assertArgvSafe, redact } from "../src/redact.ts";
import { repoRoot } from "./helpers.ts";

describe("redaction (invariants 6 and 12)", () => {
  const secrets: [string, string][] = [
    ["postgresql://neondb_owner:s3cr3t@ep-main.neon.tech/neondb", "s3cr3t"],
    ["sk_test_51AbCdEf0123456789", "51AbCdEf"],
    ["rk_live_abcdef0123456789", "abcdef0123"],
    ["whsec_0123456789abcdef", "0123456789abcdef"],
    ["acct_1TestHarbor0000", "1TestHarbor"],
    ["a".repeat(64), "a".repeat(64)],
    ["owner.person@gmail.com", "owner.person"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnop"],
  ];
  for (const [text, inner] of secrets) {
    it(`redacts ${text.slice(0, 12)}...`, () => {
      expect(redact(`x ${text} y`)).not.toContain(inner);
      expect(() => assertArgvSafe("pnpm", ["exec", text])).toThrow(/refused|api-key/);
    });
  }

  it("keeps synthetic .test addresses, version ids, and git SHAs", () => {
    const keep =
      "nov1.reef.ab12cd34@nov1-acceptance.test 11111111-2222-4333-8444-555555555555 " +
      "f".repeat(40);
    expect(redact(keep)).toBe(keep);
  });

  it("refuses --api-key in any argv", () => {
    expect(() => assertArgvSafe("stripe", ["events", "resend", "--api-key", "x"])).toThrow(
      /--api-key/,
    );
    expect(() => assertArgvSafe("stripe", ["--api-key=x"])).toThrow(/--api-key/);
  });
});

describe("the per-tenant rate plan (P6 step 6)", () => {
  it("stays at or under 30 limited calls per tenant per 60 s", () => {
    const b = budget(racePlans);
    expect([...b.keys()].sort()).toEqual(["demo-harbor", "demo-reef"]);
    for (const n of b.values()) expect(n).toBeLessThanOrEqual(publicLimitPerMinute);
    expect(b.get("demo-reef")).toBe(23);
    expect(b.get("demo-harbor")).toBe(17);
  });

  it("pays the fillers before the racers' quotes, and quotes before the race", () => {
    const reef = racePlans.find((p) => p.tenant === "demo-reef");
    expect(reef?.calls.slice(0, 6)).toEqual([
      "quote 6",
      "checkout 6",
      "pay 6",
      "quote 5",
      "checkout 5",
      "pay 5",
    ]);
    const firstRace = reef?.calls.indexOf("checkout race") ?? -1;
    expect(reef?.calls.lastIndexOf("quote 1")).toBeLessThan(firstRace);
    expect(reef?.calls.filter((c) => c === "checkout race")).toHaveLength(racers);
    // Seats: 12 total, 11 filled, 1 left for the race.
    expect(reef?.fillers.reduce((a, b) => a + b, 0)).toBe(11);
  });
});

describe("smoke profiles (pinned)", () => {
  it("runs the local subset in CI and the full set on the preview", () => {
    expect(smokeProfiles.local).toEqual([
      "health",
      "tenant-echo",
      "negative-trailing-dot",
      "negative-unpublished-host",
      "brand-manifest",
    ]);
    expect(smokeProfiles.preview).toEqual([
      "health",
      "tenant-echo",
      "negative-trailing-dot",
      "negative-unpublished-host",
      "negative-workers-dev",
      "negative-port",
      "negative-http",
      "staff-route-404",
      "brand-manifest",
      "release-csp",
    ]);
    expect(healthExpect).toEqual({
      local: { environment: "local" },
      preview: { environment: "preview" },
    });
  });
});

describe("the phase guard (invariant 11)", () => {
  const base = (): Configs => loadConfigs(repoRoot);
  const guard = (c: Configs, phase: Parameters<typeof phaseGuard>[0], flags = {}) =>
    phaseGuard(phase, c, { ...emptyJournal(), flags });

  it("passes main's configs before P3 and warns only that C1 is missing after", () => {
    expect(guard(base(), "p1").refusals).toEqual([]);
    expect(guard(base(), "p4").warnings.join()).toMatch(/C1 is not merged/);
  });

  it("refuses PAYMENT_PROVIDER=stripe outside P9", () => {
    const c = base();
    c.api.vars = { ...c.api.vars, PAYMENT_PROVIDER: "stripe" };
    expect(guard(c, "p6").refusals.join()).toMatch(/stripe outside P9/);
    expect(guard(c, "p9").refusals).toEqual([]);
  });

  it("refuses email before P7, and a sender that is not the binding's one entry", () => {
    const c = base();
    c.api.vars = {
      ...c.api.vars,
      EMAIL_PROVIDER: "cloudflare",
      EMAIL_FROM_ADDRESS: "bookings@mail.tidegrid.us",
    };
    c.api.send_email = [{ name: "EMAIL", allowed_sender_addresses: ["bookings@mail.tidegrid.us"] }];
    expect(guard(c, "p6").refusals.join()).toMatch(/before P7/);
    expect(guard(c, "p7").refusals).toEqual([]);
    c.api.vars = { ...c.api.vars, EMAIL_FROM_ADDRESS: "" };
    expect(guard(c, "p7").refusals.join()).toMatch(/default/);
    c.api.send_email = [
      { name: "EMAIL", allowed_sender_addresses: ["a@mail.tidegrid.us", "b@mail.tidegrid.us"] },
    ];
    expect(guard(c, "p7").refusals.join()).toMatch(/exactly one/);
  });

  it("refuses the cutover config outside P8 until the journal records it", () => {
    const c = base();
    c.guest.routes = [
      { pattern: "demo-harbor.book.tidegrid.us", custom_domain: true },
      { pattern: "demo-reef.book.tidegrid.us", custom_domain: true },
      { pattern: "demo.tidegrid.us", custom_domain: true },
    ];
    c.guest.workers_dev = false;
    expect(guard(c, "p7").refusals.join()).toMatch(/cutover/);
    expect(guard(c, "p8").refusals).toEqual([]);
    expect(guard(c, "p9", { cutoverDone: true }).refusals).toEqual([]);
    const odd = base();
    odd.guest.workers_dev = false;
    expect(guard(odd, "p4").refusals.join()).toMatch(/not exactly the two preview names/);
  });

  it("refuses custom hostnames outside P10, and warns when a paused cron comes back", () => {
    const c = base();
    c.api.vars = { ...c.api.vars, HOSTNAME_PROVIDER: "cloudflare_saas" };
    expect(guard(c, "p9").refusals.join()).toMatch(/outside P10/);
    expect(guard(c, "p10").refusals).toEqual([]);
    expect(guard(base(), "p11", { cronPaused: true }).warnings.join()).toMatch(/cron is paused/);
  });

  it("reads JSONC comments and trailing commas", () => {
    expect(parseJsonc('{ // c\n "a": "x//y", /* b */ "b": [1, 2,], }')).toEqual({
      a: "x//y",
      b: [1, 2],
    });
  });
});

describe("the evidence draft (P12)", () => {
  it("has no address outside the .test domains", () => {
    const j = emptyJournal();
    j.approved.push({
      sha: "c".repeat(40),
      tree: "d".repeat(40),
      gate: "P0.1",
      at: "2026-10-31T00:00:00Z",
      frozen: true,
    });
    j.entries.push({
      at: "2026-11-01T15:00:00Z",
      phase: "p6",
      step: "last-seat",
      result: "done",
      note: "booked by owner@example.com for acct_1Real000 nov1.x@nov1-acceptance.test",
    });
    const draft = renderEvidence(j, [], new Date("2026-11-01T20:00:00Z"));
    for (const m of draft.matchAll(/[^\s@|]+@([^\s|]+)/g)) expect(m[1]).toMatch(/\.test$/);
    expect(draft).not.toContain("acct_1Real");
  });
});
