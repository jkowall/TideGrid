/**
 * Findings from the 2026-11-04 run of the Nov 1 runbook and its reviews:
 * phase-forward approvals, db platform bound to the approved C4 merge in the
 * committed tree, the smoke's phase from its gate, secrets --list from what was
 * actually put, and a cron-less API outside P11.
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { releaseCsp } from "../src/commands/smoke.ts";
import { type ApprovedSha, loadJournal, saveJournal } from "../src/journal.ts";
import { approvalCounts, type Phase, phaseGuard } from "../src/phase.ts";
import {
  configsWith,
  fakeDeps,
  headSha,
  json,
  migratedHealth,
  recordingSql,
  repoRoot,
} from "./helpers.ts";

type Deps = ReturnType<typeof fakeDeps>["deps"];
const approve = (deps: Deps, ...approvals: Omit<ApprovedSha, "tree" | "at">[]) => {
  const j = loadJournal(deps);
  for (const a of approvals) j.approved.push({ tree: "t", at: "2026-11-04T12:00:00Z", ...a });
  saveJournal(deps, j);
};

describe("approvals count from their gate's phase on (owner decision 2026-11-04)", () => {
  const cases: [string, Phase, boolean][] = [
    ["P0.1", "p1", true],
    ["P0.1", "p12", true],
    ["A3", "p2", false],
    ["A3", "p3", true],
    ["A8", "p6", false],
    ["A8", "p7", true],
    ["A10", "p7", false],
    ["A10", "p8", true],
    ["A13", "p8", false],
    ["A13", "p9", true],
    ["A17", "p9", false],
    ["A17", "p10", true],
    ["A19", "p10", false],
    ["A19", "p11", true],
    ["A99", "p12", false],
  ];
  it.each(cases)("an approval under %s counts in %s: %s", (gate, phase, counts) => {
    expect(approvalCounts({ gate, frozen: gate === "P0.1" }, phase)).toBe(counts);
  });

  it("counts a P0.1 approval without --frozen nowhere, and an odd gate name nowhere", () => {
    expect(approvalCounts({ gate: "P0.1" }, "p1")).toBe(false);
    expect(approvalCounts({ gate: "P0.1", frozen: false }, "p12")).toBe(false);
    for (const gate of ["constructor", "toString", "__proto__", "hasOwnProperty"])
      expect(approvalCounts({ gate }, "p12")).toBe(false);
  });

  it("refuses a release when HEAD's only approval is a P0.1 without --frozen", async () => {
    const { deps, printed } = fakeDeps({ configs: configsWith("c1"), answers: ["tidegrid-api"] });
    approve(deps, { sha: headSha, gate: "P0.1" });
    const code = await main(["release", "api", "--phase", "p3", "--live", "--go", "A4"], deps);
    expect(code).toBe(3);
    expect(printed.join("\n")).toMatch(/P0\.1 without --frozen, which counts nowhere/);
  });

  it("refuses a P3 API release when HEAD is approved only under A10", async () => {
    const { deps, printed, execs } = fakeDeps({
      configs: configsWith("c1"),
      answers: ["tidegrid-api"],
    });
    approve(deps, { sha: headSha, gate: "A10" });
    const code = await main(["release", "api", "--phase", "p3", "--live", "--go", "A4"], deps);
    expect(code).toBe(3);
    expect(printed.join("\n")).toMatch(/approved under A10, which counts from P8 on, not in P3/);
    expect(execs.some((e) => e.args.includes("release"))).toBe(false);
  });

  it("preflight reports an approval from a later phase as a problem", async () => {
    const { deps, printed } = fakeDeps({ configs: configsWith("c1") });
    approve(deps, { sha: headSha, gate: "A13" });
    await main(["preflight", "--phase", "p7", "--offline", "--skip-build"], deps);
    expect(printed.join("\n")).toMatch(/approved under A13, which counts from P9 on, not in P7/);
  });

  it("refuses a secret put when HEAD's only approval is from a later phase", async () => {
    const { deps, printed } = fakeDeps({
      configs: configsWith("c1"),
      answers: ["tidegrid-api", "FAKE_PAYMENT_WEBHOOK_SECRET"],
    });
    approve(deps, { sha: headSha, gate: "A19" });
    const code = await main(
      [
        "secrets",
        "preview",
        "--generate",
        "FAKE_PAYMENT_WEBHOOK_SECRET",
        "--phase",
        "p3",
        "--live",
        "--go",
        "A2",
      ],
      deps,
    );
    expect(code).toBe(3);
    expect(printed.join("\n")).toMatch(/counts from P11 on/);
  });

  it("lets --frozen upgrade a SHA first approved with --go P0.1, and then the release passes the approval check", async () => {
    const twelve = headSha.slice(0, 12);
    const { deps, printed } = fakeDeps({
      configs: configsWith("c1"),
      answers: [twelve, twelve, twelve],
    });
    expect(await main(["approve-sha", headSha, "--go", "P0.1"], deps)).toBe(0);
    expect(printed.join("\n")).toMatch(/it counts nowhere/);
    expect(await main(["approve-sha", headSha, "--frozen"], deps)).toBe(0);
    expect(printed.join("\n")).not.toMatch(/already approved under P0\.1/);
    const mine = loadJournal(deps).approved.filter((a) => a.sha === headSha);
    expect(mine.map((a) => [a.gate, a.frozen === true])).toEqual([
      ["P0.1", false],
      ["P0.1", true],
    ]);
    // A second --frozen is a duplicate; a --go P0.1 after the freeze adds nothing either.
    expect(await main(["approve-sha", headSha, "--frozen"], deps)).toBe(0);
    expect(printed.at(-1)).toMatch(/already approved under P0\.1 \(frozen\)/);
    expect(loadJournal(deps).approved.filter((a) => a.sha === headSha)).toHaveLength(2);
    printed.length = 0;
    await main(["preflight", "--phase", "p3", "--offline", "--skip-build"], deps);
    expect(printed.join("\n")).not.toMatch(/counts nowhere|not in the journal's approved/);
  });
});

describe("db platform binds to the approved C4 merge in the committed tree", () => {
  const liveDb = { NEON_DATABASE_URL: "postgresql://o:p@ep-main.neon.tech/neondb" };
  const answers = ["ep-main.neon.tech", "demo-harbor", "demo.tidegrid.us"];
  const c4Merge = "4".repeat(40);
  const beforeC4 = configsWith("c1");
  const withC4 = configsWith("c1", "c4");

  function ready(o: Parameters<typeof fakeDeps>[0]) {
    const sql = recordingSql();
    sql.answers["from public.tenants where slug"] = [
      { id: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01" },
    ];
    const f = fakeDeps({ env: liveDb, answers, sql: () => sql.client, ...o });
    const j = loadJournal(f.deps);
    j.entries.push({ at: "x", phase: "p6", step: "last-seat", result: "done" });
    saveJournal(f.deps, j);
    return { ...f, sql };
  }
  const platform = ["db", "platform", "demo-harbor", "--live", "--go", "A10"];
  // HEAD is the C7 merge on top of the C4 merge; both trees carry the cutover.
  const c7OnC4 = {
    configs: withC4,
    guestHistory: [c4Merge],
    committed: {
      [headSha]: withC4,
      [`${headSha}^1`]: withC4,
      [c4Merge]: withC4,
      [`${c4Merge}^1`]: beforeC4,
    },
  };

  it("refuses a C7 merge approved under A10 when the C4 merge under it was never approved", async () => {
    const { deps, sql, printed } = ready(c7OnC4);
    approve(deps, { sha: headSha, gate: "A10" });
    expect(await main(platform, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/C4 merge 444444444444 is not approved under A10/);
    expect(sql.statements).toEqual([]);
  });

  it("writes the row once the C4 merge is approved under A10, with C7 on top", async () => {
    const { deps, sql } = ready(c7OnC4);
    approve(deps, { sha: headSha, gate: "A10" }, { sha: c4Merge, gate: "A10" });
    expect(await main(platform, deps)).toBe(0);
    expect(sql.statements.some((s) => s.text.includes("'platform', 'active'"))).toBe(true);
  });

  it("refuses when HEAD is approved only under a gate that does not count in P8", async () => {
    const { deps, sql, printed } = ready(c7OnC4);
    approve(deps, { sha: headSha, gate: "A13" }, { sha: c4Merge, gate: "A10" });
    expect(await main(platform, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/counts from P9 on, not in P8/);
    expect(sql.statements).toEqual([]);
  });

  it("reads HEAD's committed tree, not the working tree", async () => {
    // The working tree carries C4 (an uncommitted edit); HEAD's tree does not.
    const { deps, sql, printed } = ready({
      configs: withC4,
      committed: { [headSha]: beforeC4 },
    });
    approve(deps, { sha: headSha, gate: "A10" });
    expect(await main(platform, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/HEAD's committed tree does not carry the C4 cutover/);
    expect(sql.statements).toEqual([]);
  });

  it("binds to the latest C4 merge after a revert and a re-merge", async () => {
    const revert = "6".repeat(40);
    const { deps, printed } = ready({
      configs: withC4,
      guestHistory: [headSha, revert, c4Merge],
      committed: {
        [headSha]: withC4,
        [`${headSha}^1`]: beforeC4,
        [revert]: beforeC4,
        [c4Merge]: withC4,
        [`${c4Merge}^1`]: beforeC4,
      },
    });
    // The first C4 merge was approved; the re-merge (HEAD) only under P0.1.
    approve(deps, { sha: c4Merge, gate: "A10" }, { sha: headSha, gate: "P0.1", frozen: true });
    expect(await main(platform, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/C4 merge aaaaaaaaaaaa is not approved under A10/);
  });
});

describe("smoke journals its phase from its gate, and says what did not run", () => {
  const host = "demo-harbor.book.tidegrid.us";
  const origin = `https://${host}`;
  function previewSmoke() {
    return fakeDeps({
      fetch: (c) => {
        const url = new URL(c.url);
        if (url.pathname === "/v1/health")
          return json(200, { database: "ok", environment: "preview", ...migratedHealth });
        if (url.pathname === "/v1/public/tenant") {
          return c.headers.origin === origin
            ? json(
                200,
                { tenant: { slug: "demo-harbor" } },
                { "access-control-allow-origin": origin },
              )
            : json(404, { error: { code: "tenant_not_found" } });
        }
        if (url.pathname === "/v1/me") return json(404, { error: { code: "not_found" } });
        if (url.pathname === "/manifest.webmanifest")
          return json(200, { name: "Demo Harbor Charters" });
        if (url.origin === origin && url.pathname === "/")
          return new Response("<!doctype html>", {
            status: 200,
            headers: { "content-security-policy": releaseCsp(repoRoot) },
          });
        return undefined;
      },
    });
  }
  const args = (gate: string) => [
    "smoke",
    "--profile",
    "preview",
    "--base",
    "https://api.tidegrid.us",
    "--hosts",
    host,
    "--live",
    "--go",
    gate,
  ];

  it("journals p5 under A0 and p8 under A10", async () => {
    for (const [gate, phase] of [
      ["A0", "p5"],
      ["A10", "p8"],
    ] as const) {
      const { deps } = previewSmoke();
      expect(await main(args(gate), deps)).toBe(0);
      const entry = loadJournal(deps).entries.find((e) => e.step === "smoke");
      expect(entry).toMatchObject({ phase, gate, result: "done" });
    }
  });

  it("logs negative-port as not run with one host, in the output and the journal", async () => {
    const { deps, printed } = previewSmoke();
    expect(await main(args("A0"), deps)).toBe(0);
    expect(printed.join("\n")).toMatch(/NOT RUN {2}negative-port: needs a second host/);
    const entry = loadJournal(deps).entries.find((e) => e.step === "smoke");
    expect(entry?.note).toMatch(/1 not run \(negative-port\)/);
  });
});

describe("secrets --list expects what was actually put", () => {
  const list = (names: string[]) => ({
    code: 0,
    stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))),
  });
  function listing(names: string[]) {
    const f = fakeDeps({
      exec: (c) => (c.args.includes("secret") && c.args.includes("list") ? list(names) : undefined),
    });
    return f;
  }
  const put = (deps: Deps, name: string, phase: string, result: "done" | "failed" = "done") => {
    const j = loadJournal(deps);
    j.entries.push({
      at: "x",
      phase,
      step: "secret-put",
      worker: "api",
      result,
      note: `${name}; journaled, not a rollback anchor`,
    });
    saveJournal(deps, j);
  };
  const stripeList = ["secrets", "stripe", "--list", "--live", "--go", "A13"];

  it("passes in P9 when P7 was skipped and the email secret was never put", async () => {
    const { deps, printed } = listing([
      "DATABASE_URL",
      "FAKE_PAYMENT_WEBHOOK_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    put(deps, "FAKE_PAYMENT_WEBHOOK_SECRET", "p3");
    put(deps, "STRIPE_SECRET_KEY", "p9");
    put(deps, "STRIPE_WEBHOOK_SECRET", "p9");
    expect(await main(stripeList, deps)).toBe(0);
    expect(printed.join("\n")).toMatch(/missing for stripe: none; not expected: none/);
  });

  it("still reports the set's own names as missing before they are put", async () => {
    const { deps, printed } = listing(["DATABASE_URL", "FAKE_PAYMENT_WEBHOOK_SECRET"]);
    put(deps, "FAKE_PAYMENT_WEBHOOK_SECRET", "p3");
    expect(await main(stripeList, deps)).toBe(1);
    expect(printed.join("\n")).toMatch(
      /missing for stripe: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/,
    );
  });

  it("expects a later set's secret only once the journal shows it put", async () => {
    const { deps, printed } = listing(["DATABASE_URL", "FAKE_PAYMENT_WEBHOOK_SECRET"]);
    put(deps, "FAKE_PAYMENT_WEBHOOK_SECRET", "p3");
    put(deps, "EMAIL_ALLOWED_RECIPIENTS", "p7");
    expect(await main(["secrets", "preview", "--list", "--live", "--go", "A2"], deps)).toBe(1);
    expect(printed.join("\n")).toMatch(/missing for preview: EMAIL_ALLOWED_RECIPIENTS/);
  });

  it("does not expect a secret the journal shows deleted, and flags it if still present", async () => {
    const { deps, printed } = listing([
      "DATABASE_URL",
      "EMAIL_ALLOWED_RECIPIENTS",
      "FAKE_PAYMENT_WEBHOOK_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    put(deps, "FAKE_PAYMENT_WEBHOOK_SECRET", "p3");
    put(deps, "EMAIL_ALLOWED_RECIPIENTS", "p7");
    const j = loadJournal(deps);
    j.entries.push({
      at: "y",
      phase: "p7",
      step: "secret-delete",
      worker: "api",
      result: "done",
      secret: "EMAIL_ALLOWED_RECIPIENTS",
    });
    saveJournal(deps, j);
    put(deps, "STRIPE_SECRET_KEY", "p9");
    put(deps, "STRIPE_WEBHOOK_SECRET", "p9");
    expect(await main(stripeList, deps)).toBe(1);
    expect(printed.join("\n")).toMatch(/not expected: EMAIL_ALLOWED_RECIPIENTS/);
  });

  it("ignores a failed put", async () => {
    const { deps, printed } = listing([
      "DATABASE_URL",
      "FAKE_PAYMENT_WEBHOOK_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    put(deps, "EMAIL_ALLOWED_RECIPIENTS", "p7", "failed");
    expect(await main(stripeList, deps)).toBe(0);
    expect(printed.join("\n")).toMatch(/missing for stripe: none/);
  });

  it("records the secret's name as a field on new put and delete entries", async () => {
    const { deps } = fakeDeps({
      configs: configsWith("c1"),
      answers: ["tidegrid-api", "FAKE_PAYMENT_WEBHOOK_SECRET"],
      exec: (c) =>
        c.args.includes("deployments")
          ? {
              code: 0,
              stdout: JSON.stringify([
                { versions: [{ version_id: "33333333-2222-4333-8444-555555555555" }] },
              ]),
            }
          : undefined,
    });
    approve(deps, { sha: headSha, gate: "P0.1", frozen: true });
    const del = [
      "secrets",
      "preview",
      "--delete",
      "FAKE_PAYMENT_WEBHOOK_SECRET",
      "--phase",
      "p3",
      "--live",
      "--go",
      "A2",
    ];
    expect(await main(del, deps)).toBe(0);
    const entry = loadJournal(deps).entries.find((e) => e.step === "secret-delete");
    expect(entry?.secret).toBe("FAKE_PAYMENT_WEBHOOK_SECRET");
  });
});

describe("the phase guard warns on a cron-less API outside P11", () => {
  const guard = (phase: Phase, flags = {}) =>
    phaseGuard(phase, configsWith("c1", "c6"), {
      version: 1,
      approved: [],
      entries: [],
      flags,
    });

  it("warns in P3 to P10 and P12 when the journal has no pause", () => {
    for (const phase of ["p3", "p7", "p9", "p12"] as const) {
      expect(guard(phase).warnings.join()).toMatch(/carries no cron outside P11/);
      expect(guard(phase).refusals).toEqual([]);
    }
  });

  it("stays quiet in P11, and after the journal records the pause", () => {
    expect(guard("p11").warnings.join()).not.toMatch(/no cron/);
    expect(guard("p12", { cronPaused: true }).warnings.join()).not.toMatch(/no cron/);
  });

  it("stays quiet on a guest or console release, which never carries the API's cron", () => {
    const c = configsWith("c1", "c6");
    const j = { version: 1 as const, approved: [], entries: [], flags: {} };
    expect(phaseGuard("p7", c, j, "guest").warnings.join()).not.toMatch(/no cron/);
    expect(phaseGuard("p7", c, j, "api").warnings.join()).toMatch(/no cron/);
  });

  it("stays quiet when the config keeps its cron", () => {
    const c = configsWith("c1");
    const g = phaseGuard("p7", c, { version: 1, approved: [], entries: [], flags: {} });
    expect(g.warnings.join()).not.toMatch(/no cron/);
  });
});
