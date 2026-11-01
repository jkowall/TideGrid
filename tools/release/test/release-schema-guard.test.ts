/**
 * An API release refuses while the database is behind the tree's last
 * migration. The live API's health reads `migrations.latest` from the
 * database (apps/api-worker/src/routes/system.ts), so a release before the
 * migration is applied would put code on a schema it does not match. From
 * 0014 on, that code refuses every staff email resend at commit.
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { treeMigrations } from "../src/commands/preflight.ts";
import { loadJournal, saveJournal } from "../src/journal.ts";
import { fakeDeps, headSha, json, providerExecs, repoRoot } from "./helpers.ts";

const releaseApi = ["release", "api", "--phase", "p3", "--live", "--go", "A4"];
const treeLatest = treeMigrations(repoRoot).at(-1) ?? "";

function approve(deps: ReturnType<typeof fakeDeps>["deps"]) {
  const j = loadJournal(deps);
  j.approved.push({ sha: headSha, tree: "t", gate: "P0.1", at: "x", frozen: true });
  saveJournal(deps, j);
}

/** Health answers "old" until the deploy runs, then this build. */
function withHealth(migrations: unknown) {
  let deployed = false;
  const f = fakeDeps({
    answers: ["tidegrid-api"],
    exec: (c) => {
      if (c.args.includes("release")) deployed = true;
      return undefined;
    },
    fetch: (c) =>
      c.url.endsWith("/v1/health")
        ? json(200, {
            version: deployed ? "aaaaaaa" : "old",
            database: "ok",
            ...(migrations === undefined ? {} : { migrations }),
          })
        : undefined,
  });
  approve(f.deps);
  return f;
}

describe("an API release waits for the database to reach the tree's last migration", () => {
  it("knows the tree's last migration", () => {
    expect(treeLatest).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it("refuses, before any provider call, when the database is behind", async () => {
    const { deps, execs, printed } = withHealth({ latest: "0001_foundation.sql" });
    expect(await main(releaseApi, deps)).toBe(3);
    const text = printed.join("\n");
    expect(text).toMatch(/database is at 0001_foundation\.sql/);
    expect(text).toContain(treeLatest);
    expect(providerExecs(execs)).toEqual([]);
  });

  it("refuses when the database reports no migrations at all", async () => {
    const { deps, execs } = withHealth({ applied: 0, latest: null });
    expect(await main(releaseApi, deps)).toBe(3);
    expect(providerExecs(execs)).toEqual([]);
  });

  it("releases when the database is at the tree's last migration", async () => {
    const { deps, printed } = withHealth({ latest: treeLatest });
    expect(await main(releaseApi, deps), printed.join("\n")).toBe(0);
    expect(printed.join("\n")).not.toMatch(/WARN .*migration/);
  });

  it("releases with a warning when the database is ahead of the tree", async () => {
    const { deps, printed } = withHealth({ latest: "9999_from_a_later_tree.sql" });
    expect(await main(releaseApi, deps), printed.join("\n")).toBe(0);
    expect(printed.join("\n")).toMatch(/WARN .*ahead of the tree/);
  });

  it("releases with a warning when the live health cannot say", async () => {
    const { deps, printed } = withHealth(undefined);
    expect(await main(releaseApi, deps), printed.join("\n")).toBe(0);
    expect(printed.join("\n")).toMatch(/WARN .*could not read the database's migrations/);
  });
});
