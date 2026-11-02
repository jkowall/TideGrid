/**
 * A rollback is done only when exactly the anchor is live afterwards.
 * wrangler 4.135.0 exits 0 when the owner declines its changed-secrets
 * prompt (code 10220): it prints "Aborting rollback...", then falls through
 * to its success line (cli.js:349407-349415). Runbook Rule 6 deletes a
 * secret before a rollback, so that prompt is likely on the day.
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { loadJournal, saveJournal } from "../src/journal.ts";
import { fakeDeps, headSha } from "./helpers.ts";

const v = (n: number) => `${String(n).repeat(8)}-2222-4333-8444-555555555555`;
const listing = (...ids: string[]) => ({
  code: 0,
  stdout: JSON.stringify([{ versions: ids.map((version_id) => ({ version_id })) }]),
});

/** A live, approved journal with one done p3 release of the API, v(1) to v(2). */
function setUp(afterRollback: () => { code: number; stdout: string }, rollbackCode = 0) {
  let rolled = false;
  const f = fakeDeps({
    answers: ["tidegrid-api", v(1).slice(0, 8), "yes"],
    exec: (c) => {
      if (c.args.includes("rollback")) {
        rolled = true;
        return { code: rollbackCode, stdout: "" };
      }
      if (c.args.includes("deployments")) return rolled ? afterRollback() : listing(v(2));
      return undefined;
    },
  });
  const j = loadJournal(f.deps);
  j.approved.push({ sha: headSha, tree: "t", gate: "P0.1", at: "x", frozen: true });
  j.entries.push({
    at: "2026-11-01T15:00:00Z",
    phase: "p3",
    step: "release",
    worker: "api",
    result: "done",
    sha: headSha,
    versionBefore: [v(1)],
    versionAfter: [v(2)],
  });
  saveJournal(f.deps, j);
  return f;
}

const run = (deps: ReturnType<typeof fakeDeps>["deps"]) =>
  main(["release", "api", "--phase", "p7", "--rollback", "--live", "--go", "A8"], deps);

function lastRollback(deps: ReturnType<typeof fakeDeps>["deps"]) {
  return loadJournal(deps)
    .entries.filter((e) => e.step === "rollback")
    .at(-1);
}

describe("rollback postcondition: done only when exactly the anchor is live", () => {
  it("rolls back when the anchor alone is live afterwards", async () => {
    const { deps, printed } = setUp(() => listing(v(1)));
    expect(await run(deps), printed.join("\n")).toBe(0);
    expect(lastRollback(deps)?.result).toBe("done");
    expect(lastRollback(deps)?.versionAfter).toEqual([v(1)]);
    expect(loadJournal(deps).flags.rolledBack).toEqual(["api"]);
  });

  it("fails when wrangler exits 0 but the old version is still live (a declined prompt)", async () => {
    const { deps, printed } = setUp(() => listing(v(2)));
    expect(await run(deps)).toBe(1);
    expect(printed.join("\n")).toMatch(/FAILED: .*not live/);
    expect(printed.join("\n")).not.toMatch(/rolled back to/);
    expect(lastRollback(deps)?.result).toBe("failed");
    expect(lastRollback(deps)?.versionAfter).toEqual([v(2)]);
    expect(loadJournal(deps).flags.rolledBack ?? []).toEqual([]);
  });

  it("fails when the anchor is live beside another version (a split)", async () => {
    const { deps } = setUp(() => listing(v(1), v(2)));
    expect(await run(deps)).toBe(1);
    expect(lastRollback(deps)?.result).toBe("failed");
    expect(loadJournal(deps).flags.rolledBack ?? []).toEqual([]);
  });

  it("reads the listing once more after 5 s, and rolls back when it has caught up", async () => {
    let reads = 0;
    const { deps, printed } = setUp(() => {
      reads += 1;
      return reads === 1 ? listing(v(2)) : listing(v(1));
    });
    const start = deps.now().getTime();
    expect(await run(deps), printed.join("\n")).toBe(0);
    expect(reads).toBe(2);
    expect(deps.now().getTime() - start).toBe(5000);
    expect(printed.join("\n")).toMatch(/reading it again in 5 s/);
    expect(lastRollback(deps)?.result).toBe("done");
    expect(lastRollback(deps)?.versionAfter).toEqual([v(1)]);
  });

  it("reads once more after an unreadable listing, and rolls back when the second read works", async () => {
    let reads = 0;
    const { deps, printed } = setUp(() => {
      reads += 1;
      return reads === 1 ? { code: 1, stdout: "" } : listing(v(1));
    });
    expect(await run(deps), printed.join("\n")).toBe(0);
    expect(lastRollback(deps)?.result).toBe("done");
    expect(lastRollback(deps)?.note ?? "").not.toMatch(/unreadable/);
  });

  it("reads only once when the anchor is live at the first read", async () => {
    let reads = 0;
    const { deps } = setUp(() => {
      reads += 1;
      return listing(v(1));
    });
    const start = deps.now().getTime();
    expect(await run(deps)).toBe(0);
    expect(reads).toBe(1);
    expect(deps.now().getTime() - start).toBe(0);
  });

  it("reads twice, no more, before it fails", async () => {
    let reads = 0;
    const { deps } = setUp(() => {
      reads += 1;
      return listing(v(2));
    });
    expect(await run(deps)).toBe(1);
    expect(reads).toBe(2);
  });

  it("fails at once, with no second read and no wait, when wrangler exits non-zero", async () => {
    let reads = 0;
    const { deps, printed } = setUp(() => {
      reads += 1;
      return listing(v(2));
    }, 1);
    const start = deps.now().getTime();
    expect(await run(deps)).toBe(1);
    expect(reads).toBe(1);
    expect(deps.now().getTime() - start).toBe(0);
    expect(printed.join("\n")).toMatch(/FAILED: wrangler rollback exited 1/);
    expect(lastRollback(deps)?.result).toBe("failed");
    expect(loadJournal(deps).flags.rolledBack ?? []).toEqual([]);
  });

  it("fails, and keeps the rolled-back flag, when the listing cannot be read on either read", async () => {
    let reads = 0;
    const { deps, printed } = setUp(() => {
      reads += 1;
      return { code: 1, stdout: "" };
    });
    expect(await run(deps)).toBe(1);
    expect(reads).toBe(2);
    expect(lastRollback(deps)?.note).toMatch(/unreadable/);
    expect(printed.join("\n")).toMatch(/FAILED: .*wrangler deployments list/);
    expect(lastRollback(deps)?.result).toBe("failed");
    // Conservative: the rollback may have run, so secret edits keep pointing
    // to the versions path until the owner checks the listing.
    expect(loadJournal(deps).flags.rolledBack).toEqual(["api"]);
  });
});
