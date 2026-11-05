/**
 * cutoverMerge against a real git repository in a temporary directory, so the
 * first-parent, path-limited rev-list and `git show <rev>^1:<path>` behave as
 * git does, not as the fakes in helpers.ts answer them. No network.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cutoverMerge } from "../src/git.ts";
import { configPaths } from "../src/phase.ts";
import { configsWith, fakeDeps } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "nov1-cutover-git-"));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_AUTHOR_EMAIL: "synthetic@example.test",
  GIT_COMMITTER_NAME: "Synthetic",
  GIT_COMMITTER_EMAIL: "synthetic@example.test",
};
const run = (...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    env: gitEnv,
    encoding: "utf8",
  }).trim();
const write = (path: string, body: unknown) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), `${JSON.stringify(body, null, 2)}\n`);
};

const preview = configsWith("c1").guest;
const cutover = configsWith("c1", "c4").guest;
const sha: Record<string, string> = {};

/** Merge a one-commit branch into main with --no-ff, as a pull request merge does. */
function mergeBranch(name: string, change: () => void) {
  run("checkout", "-q", "-b", name, "main");
  change();
  run("add", "-A");
  run("commit", "-q", "-m", name);
  run("checkout", "-q", "main");
  run("merge", "-q", "--no-ff", "-m", `Merge ${name}`, name);
  return run("rev-parse", "HEAD");
}

beforeAll(() => {
  run("init", "-q", "-b", "main");
  write(configPaths.guest, preview);
  write("README.md", "root");
  run("add", "-A");
  run("commit", "-q", "-m", "root");
  sha.root = run("rev-parse", "HEAD");
  sha.c4 = mergeBranch("c4", () => write(configPaths.guest, cutover));
  sha.c7 = mergeBranch("c7", () => write("wrangler.prototype.jsonc", { routes: [] }));
  run("revert", "--no-edit", "-m", "1", sha.c4);
  sha.revert = run("rev-parse", "HEAD");
  sha.c4again = mergeBranch("c4-again", () => write(configPaths.guest, cutover));
});

function realDeps() {
  const { deps } = fakeDeps({ env: { PATH: process.env.PATH ?? "/usr/bin" } });
  deps.repoRoot = dir;
  deps.exec = async (cmd, args, options) => {
    const r = spawnSync(cmd, [...args], {
      cwd: options.cwd ?? dir,
      env: options.env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? "" };
  };
  return deps;
}

describe("cutoverMerge on real git history", () => {
  it("names the C4 merge when C7 is merged on top of it", async () => {
    expect(await cutoverMerge(realDeps(), sha.c7 as string)).toBe(sha.c4);
  });

  it("names the C4 merge at the C4 merge itself", async () => {
    expect(await cutoverMerge(realDeps(), sha.c4 as string)).toBe(sha.c4);
  });

  it("finds nothing before C4 or after its revert", async () => {
    expect(await cutoverMerge(realDeps(), sha.root as string)).toBeNull();
    expect(await cutoverMerge(realDeps(), sha.revert as string)).toBeNull();
  });

  it("names the re-merge, not the first C4 merge, after a revert", async () => {
    expect(await cutoverMerge(realDeps(), sha.c4again as string)).toBe(sha.c4again);
  });
});
