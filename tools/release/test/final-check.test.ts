/**
 * Tests for the final check of #34 (2026-10-28): the rollback anchor after a
 * release that failed before upload, and db platform bound to the C4 merge.
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { rollbackAnchor } from "../src/commands/release.ts";
import { emptyJournal, loadJournal, saveJournal } from "../src/journal.ts";
import { configsWith, fakeDeps, headSha, providerExecs, recordingSql } from "./helpers.ts";

const v = (n: number) => `${String(n).repeat(8)}-2222-4333-8444-555555555555`;
const listing = (id: string) => ({
  code: 0,
  stdout: JSON.stringify([{ versions: [{ version_id: id }] }]),
});

describe("the rollback anchor skips a release that changed nothing", () => {
  it("anchors on the last release that moved the version, not a failed retry", () => {
    const j = emptyJournal();
    j.entries.push(
      {
        at: "1",
        phase: "p7",
        step: "release",
        worker: "api",
        result: "done",
        versionBefore: [v(1)],
        versionAfter: [v(2)],
      },
      {
        at: "2",
        phase: "p7",
        step: "release",
        worker: "api",
        result: "started",
        versionBefore: [v(2)],
      },
      {
        at: "3",
        phase: "p7",
        step: "release",
        worker: "api",
        result: "failed",
        versionBefore: [v(2)],
        versionAfter: [v(2)],
        note: "exit 1",
      },
    );
    expect(rollbackAnchor(j, "api")?.versionBefore).toEqual([v(1)]);
  });

  it("refuses a rollback to the version that is already live", async () => {
    const { deps, execs, printed } = fakeDeps({
      answers: ["tidegrid-api", v(2).slice(0, 8), "yes"],
      exec: (c) => (c.args.includes("deployments") ? listing(v(2)) : undefined),
    });
    expect(
      await main(
        ["release", "api", "--phase", "p7", "--rollback", "--to", v(2), "--live", "--go", "A8"],
        deps,
      ),
    ).toBe(3);
    expect(printed.join("\n")).toMatch(/already live/);
    expect(execs.filter((e) => e.args.includes("rollback"))).toEqual([]);
  });
});

describe("db platform is bound to the C4 merge", () => {
  const liveDb = { NEON_DATABASE_URL: "postgresql://o:p@ep-main.neon.tech/neondb" };
  const answers = ["ep-main.neon.tech", "demo-harbor", "demo.tidegrid.us"];

  function ready(configs: ReturnType<typeof configsWith>, approvedHead: boolean) {
    const sql = recordingSql();
    sql.answers["from public.tenants where slug"] = [
      { id: "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01" },
    ];
    const f = fakeDeps({ env: liveDb, answers, configs, sql: () => sql.client });
    const j = loadJournal(f.deps);
    j.entries.push({ at: "x", phase: "p6", step: "last-seat", result: "done" });
    // A C7 merge approved under A10 (some other SHA), and maybe HEAD.
    j.approved.push({ sha: "c".repeat(40), tree: "t", gate: "A10", at: "x" });
    if (approvedHead) j.approved.push({ sha: headSha, tree: "t", gate: "A10", at: "y" });
    saveJournal(f.deps, j);
    return { ...f, sql };
  }

  it("refuses when only C7 is approved and the tree has no cutover config", async () => {
    const { deps, sql, printed } = ready(configsWith("c1"), false);
    expect(await main(["db", "platform", "demo-harbor", "--live", "--go", "A10"], deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/C4/);
    expect(sql.statements).toEqual([]);
  });

  it("refuses when HEAD carries C4 but HEAD itself is not approved under A10", async () => {
    const { deps, sql } = ready(configsWith("c1", "c4"), false);
    expect(await main(["db", "platform", "demo-harbor", "--live", "--go", "A10"], deps)).toBe(3);
    expect(sql.statements).toEqual([]);
  });

  it("writes the row once HEAD is the approved tree that carries C4", async () => {
    const { deps, sql, execs } = ready(configsWith("c1", "c4"), true);
    expect(await main(["db", "platform", "demo-harbor", "--live", "--go", "A10"], deps)).toBe(0);
    expect(sql.statements.some((s) => s.text.includes("'platform', 'active'"))).toBe(true);
    expect(providerExecs(execs)).toEqual([]);
  });
});

describe("secret changes are journaled, but are not rollback anchors", () => {
  it("says so instead of naming a new anchor", async () => {
    const { deps, printed } = fakeDeps({
      configs: configsWith("c1"),
      answers: ["tidegrid-api", "FAKE_PAYMENT_WEBHOOK_SECRET"],
      exec: (c) => (c.args.includes("deployments") ? listing(v(3)) : undefined),
    });
    const j = loadJournal(deps);
    j.approved.push({ sha: headSha, tree: "t", gate: "P0.1", at: "x" });
    saveJournal(deps, j);
    expect(
      await main(
        [
          "secrets",
          "preview",
          "--delete",
          "FAKE_PAYMENT_WEBHOOK_SECRET",
          "--phase",
          "p3",
          "--live",
          "--go",
          "A2",
        ],
        deps,
      ),
    ).toBe(0);
    const text = printed.join("\n");
    expect(text).not.toMatch(/rollback anchor now/);
    expect(text).toMatch(/not a rollback anchor/);
  });
});
