/**
 * Tests for the #34 review findings (2026-10-28): config-branch independence
 * (safety F1), the secrets phase (safety F2, correctness F2), the end of the
 * Stripe window (correctness F1, safety F4), the rollback anchor (safety F3),
 * and the cutover flag (correctness F3).
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { emptyJournal, loadJournal, saveJournal } from "../src/journal.ts";
import { type Phase, phaseGuard } from "../src/phase.ts";
import {
  type ConfigBranch,
  configsWith,
  fakeDeps,
  headSha,
  json,
  providerExecs,
} from "./helpers.ts";

const v = (n: number) => `${String(n).repeat(8)}-2222-4333-8444-555555555555`;
const listing = (id: string) => ({
  code: 0,
  stdout: JSON.stringify([{ versions: [{ version_id: id }] }]),
});

function approve(deps: ReturnType<typeof fakeDeps>["deps"], flags = {}) {
  const j = loadJournal(deps);
  j.approved.push({
    sha: headSha,
    tree: "t",
    gate: "P0.1",
    at: "2026-10-31T00:00:00Z",
    frozen: true,
  });
  j.flags = { ...j.flags, ...flags };
  saveJournal(deps, j);
}

describe("safety F1: each config branch passes the guard in its phase and is refused outside it", () => {
  const cases: [string, ConfigBranch[], Phase[], Phase[], object?][] = [
    ["C1", ["c1"], ["p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11", "p12"], []],
    ["C1+C2", ["c1", "c2"], ["p7", "p8", "p9", "p10", "p11"], ["p3", "p4", "p6"]],
    ["C1+C3", ["c1", "c3"], ["p10"], ["p3", "p9", "p11"]],
    ["C1+C4", ["c1", "c4"], ["p8"], ["p4", "p7", "p9"]],
    ["C1+C4 after the cutover", ["c1", "c4"], ["p9", "p10", "p11"], [], { cutoverDone: true }],
    ["C1+C5", ["c1", "c5"], ["p9"], ["p6", "p8", "p10", "p11"]],
    ["C1+C6", ["c1", "c6"], ["p3", "p11"], []],
    [
      "the P9 state: C1+C2+C4+C5",
      ["c1", "c2", "c4", "c5"],
      ["p9"],
      ["p10", "p11"],
      { cutoverDone: true },
    ],
    [
      "P11 after C5 is reverted: C1+C2+C4+C6",
      ["c1", "c2", "c4", "c6"],
      ["p10", "p11", "p12"],
      [],
      { cutoverDone: true },
    ],
  ];
  for (const [name, branches, pass, refuse, flags] of cases) {
    it(name, () => {
      const configs = configsWith(...branches);
      const journal = { ...emptyJournal(), flags: { ...(flags ?? {}) } };
      for (const p of pass)
        expect(phaseGuard(p, configs, journal).refusals, `${name} in ${p}`).toEqual([]);
      for (const p of refuse)
        expect(phaseGuard(p, configs, journal).refusals.length, `${name} in ${p}`).toBeGreaterThan(
          0,
        );
    });
  }

  it("the command tests do not read the tree's configs", () => {
    const { deps } = fakeDeps();
    expect(deps.configs().api.vars?.PUBLIC_CORS).toBe("static");
  });
});

describe("safety F2 and correctness F2: nov1 secrets guards the current phase; feature-off always runs", () => {
  const p9 = configsWith("c1", "c2", "c4", "c5");

  it("deletes the fake's secret at the end of P9, with C2, C4, and C5 merged", async () => {
    const { deps, execs, printed } = fakeDeps({
      configs: p9,
      answers: ["tidegrid-api", "FAKE_PAYMENT_WEBHOOK_SECRET"],
    });
    approve(deps, { cutoverDone: true });
    const code = await main(
      [
        "secrets",
        "preview",
        "--delete",
        "FAKE_PAYMENT_WEBHOOK_SECRET",
        "--phase",
        "p9",
        "--live",
        "--go",
        "A2",
      ],
      deps,
    );
    expect(code, printed.join("\n")).toBe(0);
    expect(execs.find((e) => e.args.includes("delete"))?.args).toEqual([
      "exec",
      "wrangler",
      "secret",
      "delete",
      "FAKE_PAYMENT_WEBHOOK_SECRET",
    ]);
  });

  it("turns email off in P9 with C5 merged, and the fake off after C2 merged (P3 rollback step 1)", async () => {
    const email = fakeDeps({ configs: p9, answers: ["tidegrid-api", "EMAIL_ALLOWED_RECIPIENTS"] });
    approve(email.deps, { cutoverDone: true });
    expect(
      await main(
        [
          "secrets",
          "email",
          "--delete",
          "EMAIL_ALLOWED_RECIPIENTS",
          "--phase",
          "p9",
          "--live",
          "--go",
          "A7",
        ],
        email.deps,
      ),
    ).toBe(0);
    const fake = fakeDeps({
      configs: configsWith("c1", "c2"),
      answers: ["tidegrid-api", "FAKE_PAYMENT_WEBHOOK_SECRET"],
    });
    approve(fake.deps);
    expect(
      await main(
        [
          "secrets",
          "preview",
          "--delete",
          "FAKE_PAYMENT_WEBHOOK_SECRET",
          "--phase",
          "p7",
          "--live",
          "--go",
          "A2",
        ],
        fake.deps,
      ),
    ).toBe(0);
  });

  it("still guards a put against the current phase", async () => {
    const { deps, execs, printed } = fakeDeps({
      configs: configsWith("c1", "c2"),
      answers: ["tidegrid-api", "FAKE_PAYMENT_WEBHOOK_SECRET"],
    });
    approve(deps);
    expect(
      await main(
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
      ),
    ).toBe(3);
    expect(printed.join("\n")).toMatch(/before P7/);
    expect(providerExecs(execs)).toEqual([]);
  });

  it("refuses a put before the set's own phase, and a live change with no --phase", async () => {
    const early = fakeDeps({
      configs: configsWith("c1", "c5"),
      answers: ["tidegrid-api", "STRIPE_SECRET_KEY"],
    });
    approve(early.deps);
    expect(
      await main(
        [
          "secrets",
          "stripe",
          "--put",
          "STRIPE_SECRET_KEY",
          "--phase",
          "p6",
          "--live",
          "--go",
          "A13",
        ],
        early.deps,
      ),
    ).toBe(3);
    expect(early.printed.join("\n")).toMatch(/P9/);
    const none = fakeDeps({ answers: ["tidegrid-api", "FAKE_PAYMENT_WEBHOOK_SECRET"] });
    approve(none.deps);
    expect(
      await main(
        ["secrets", "preview", "--delete", "FAKE_PAYMENT_WEBHOOK_SECRET", "--live", "--go", "A2"],
        none.deps,
      ),
    ).toBe(3);
    expect(none.printed.join("\n")).toMatch(/--phase/);
  });
});

describe("correctness F1 and safety F4: the Stripe window closes before P10 and P11", () => {
  it("refuses a P11 release while C5 is still merged, and says to revert it", async () => {
    const { deps, execs, printed } = fakeDeps({
      configs: configsWith("c1", "c2", "c4", "c5", "c6"),
      answers: ["tidegrid-api"],
    });
    approve(deps, { cutoverDone: true });
    expect(await main(["release", "api", "--phase", "p11", "--live", "--go", "A19"], deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/revert C5/);
    expect(providerExecs(execs)).toEqual([]);
  });

  it("releases P11 once C5 is reverted (C1+C2+C4+C6), and records the cron pause", async () => {
    let health = 0;
    const { deps, printed } = fakeDeps({
      configs: configsWith("c1", "c2", "c4", "c6"),
      answers: ["tidegrid-api"],
      fetch: (c) =>
        c.url.endsWith("/v1/health")
          ? json(200, { version: ++health > 1 ? "aaaaaaa" : "old", database: "ok" })
          : undefined,
    });
    approve(deps, { cutoverDone: true });
    expect(
      await main(["release", "api", "--phase", "p11", "--live", "--go", "A19"], deps),
      printed.join("\n"),
    ).toBe(0);
    expect(loadJournal(deps).flags.cronPaused).toBe(true);
  });

  it("releases P10 after P9 once C5 is reverted", async () => {
    let health = 0;
    const { deps, printed } = fakeDeps({
      configs: configsWith("c1", "c2", "c3", "c4"),
      answers: ["tidegrid-api"],
      fetch: (c) =>
        c.url.endsWith("/v1/health")
          ? json(200, { version: ++health > 1 ? "aaaaaaa" : "old", database: "ok" })
          : undefined,
    });
    approve(deps, { cutoverDone: true });
    expect(
      await main(["release", "api", "--phase", "p10", "--live", "--go", "A17"], deps),
      printed.join("\n"),
    ).toBe(0);
  });
});

describe("safety F3: the rollback anchor is the build that was live before the last release", () => {
  it("targets the version before a failed release, and makes the owner type it", async () => {
    const { deps, execs, prompts, printed } = fakeDeps({
      configs: configsWith("c1", "c2"),
      answers: ["tidegrid-api", v(1).slice(0, 8), "yes"],
      exec: (c) => (c.args.includes("deployments") ? listing(v(2)) : undefined),
    });
    approve(deps);
    const j = loadJournal(deps);
    j.entries.push(
      {
        at: "2026-11-01T15:00:00Z",
        phase: "p3",
        step: "release",
        worker: "api",
        result: "done",
        sha: headSha,
        versionBefore: [v(0)],
        versionAfter: [v(1)],
      },
      {
        at: "2026-11-01T19:00:00Z",
        phase: "p7",
        step: "release",
        worker: "api",
        result: "started",
        sha: headSha,
        versionBefore: [v(1)],
      },
      {
        at: "2026-11-01T19:02:00Z",
        phase: "p7",
        step: "release",
        worker: "api",
        result: "failed",
        sha: headSha,
        versionBefore: [v(1)],
        versionAfter: [v(2)],
        note: "postcondition not met",
      },
    );
    saveJournal(deps, j);
    expect(
      await main(["release", "api", "--phase", "p7", "--rollback", "--live", "--go", "A8"], deps),
      printed.join("\n"),
    ).toBe(0);
    expect(execs.find((e) => e.args.includes("rollback"))?.args).toEqual([
      "exec",
      "wrangler",
      "rollback",
      v(1),
    ]);
    expect(prompts.some((p) => p.includes(v(1).slice(0, 8)))).toBe(true);
    expect(printed.join("\n")).toMatch(/p7 release .*failed/);
  });

  it("refuses when the typed anchor does not match", async () => {
    const { deps, execs } = fakeDeps({ answers: ["tidegrid-api", v(0).slice(0, 8)] });
    approve(deps);
    const j = loadJournal(deps);
    j.entries.push({
      at: "x",
      phase: "p3",
      step: "release",
      worker: "api",
      result: "done",
      versionBefore: [v(1)],
    });
    saveJournal(deps, j);
    expect(
      await main(["release", "api", "--phase", "p3", "--rollback", "--live", "--go", "A4"], deps),
    ).toBe(3);
    expect(execs.filter((e) => e.args.includes("rollback"))).toEqual([]);
  });
});

describe("correctness F3: the cutover flag follows the deploy, not the certificate poll", () => {
  const cutover = () => configsWith("c1", "c4");

  it("records the cutover when wrangler exits 0, even if the hosts are not serving yet", async () => {
    const { deps } = fakeDeps({
      configs: cutover(),
      answers: ["tidegrid-guest"],
      fetch: () => new Response("", { status: 526 }),
    });
    approve(deps);
    expect(await main(["release", "guest", "--phase", "p8", "--live", "--go", "A10"], deps)).toBe(
      1,
    );
    const journal = loadJournal(deps);
    expect(journal.flags.cutoverDone).toBe(true);
    expect(journal.entries.at(-1)).toMatchObject({
      step: "release",
      worker: "guest",
      result: "failed",
      note: expect.stringMatching(/deployed; postcondition not met/),
    });
    // A later phase is not blocked by the slow certificate.
    expect(phaseGuard("p9", configsWith("c1", "c4", "c5"), journal).refusals).toEqual([]);
  });

  it("--verify reruns only the postcondition and records it done", async () => {
    const { deps, execs } = fakeDeps({
      configs: cutover(),
      answers: [],
      fetch: () => new Response("ok", { status: 200 }),
    });
    approve(deps, { cutoverDone: true });
    expect(
      await main(["release", "guest", "--phase", "p8", "--verify", "--live", "--go", "A10"], deps),
    ).toBe(0);
    expect(providerExecs(execs)).toEqual([]);
    expect(loadJournal(deps).entries.at(-1)).toMatchObject({
      step: "release-verify",
      worker: "guest",
      result: "done",
    });
  });

  it("clears the flag when a P8 guest release carries the preview set again (the cutover rollback)", async () => {
    const { deps } = fakeDeps({
      configs: configsWith("c1"),
      answers: ["tidegrid-guest"],
      fetch: () => new Response("ok", { status: 200 }),
    });
    approve(deps, { cutoverDone: true });
    expect(
      await main(["release", "guest", "--phase", "p8", "--live", "--go", "A10", "--again"], deps),
    ).toBe(0);
    expect(loadJournal(deps).flags.cutoverDone).toBe(false);
  });
});
