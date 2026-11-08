/**
 * nov1 ci-check: the CI gate alone, read-only, allowed under CI because the
 * neon-migrate workflow runs it before the job that holds the Neon secrets.
 */
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import {
  type GhWorld,
  ghFrom,
  greenWorld,
  recorded7ef,
  recorded7efJobs,
  recordedDd3,
  recordedDd3Jobs,
  sha7ef,
  shaDd3,
} from "./ci-fixtures.ts";
import { fakeDeps, headSha } from "./helpers.ts";

function withWorld(world: GhWorld, env: Record<string, string> = {}) {
  const gh = ghFrom(world);
  return fakeDeps({ tty: false, env, exec: (c) => gh(c) });
}

describe("nov1 ci-check", () => {
  it("passes 7ef50cf's recorded push run under CI, with no terminal and no journal", async () => {
    const world = { runs: [recorded7ef], jobs: { [recorded7ef.id]: recorded7efJobs } };
    const { deps, printed, prompts, execs } = withWorld(world, { CI: "true" });
    expect(await main(["ci-check", sha7ef], deps)).toBe(0);
    expect(printed.join("\n")).toContain(
      `CI green for ${sha7ef.slice(0, 12)}: https://github.com/jkowall/TideGrid/actions/runs/`,
    );
    expect(prompts).toEqual([]);
    expect(execs.every((e) => e.cmd === "gh" || e.cmd === "git")).toBe(true);
    const journalFiles = existsSync(deps.stateDir) ? readdirSync(deps.stateDir) : [];
    expect(journalFiles).toEqual([]);
  });

  it("refuses dd30fc8's recorded push run: three jobs skipped", async () => {
    const world = { runs: [recordedDd3], jobs: { [recordedDd3.id]: recordedDd3Jobs } };
    const { deps, printed } = withWorld(world, { CI: "true" });
    expect(await main(["ci-check", shaDd3], deps)).toBe(3);
    expect(printed.join("\n")).toContain("not green on all four jobs");
  });

  it("refuses a SHA with no run", async () => {
    const { deps, printed } = withWorld({ runs: [], jobs: {} });
    expect(await main(["ci-check", headSha], deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/no CI run of ci\.yml on main has tested/);
  });

  it("refuses a short SHA, extra arguments, and any flag before asking GitHub", async () => {
    for (const argv of [
      ["ci-check", headSha.slice(0, 12)],
      ["ci-check"],
      ["ci-check", headSha, headSha],
      ["ci-check", headSha, "--live"],
    ]) {
      const { deps, execs } = withWorld(greenWorld(headSha));
      expect(await main(argv, deps)).not.toBe(0);
      expect(execs.filter((e) => e.cmd === "gh")).toEqual([]);
    }
  });
});
