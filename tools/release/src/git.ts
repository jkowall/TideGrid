/**
 * Read-only git checks (invariant 3), run just before every live action.
 * Local reads only: nothing here fetches.
 */
import { type Deps, Refusal } from "./core.ts";
import { childEnv } from "./env.ts";
import { type Journal, loadJournal } from "./journal.ts";

export async function git(deps: Deps, args: readonly string[]): Promise<string> {
  const result = await deps.exec("git", args, {
    cwd: deps.repoRoot,
    env: childEnv(deps),
    stdio: "pipe",
  });
  if (result.code !== 0) throw new Refusal(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export interface ReleaseState {
  head: string;
  originMain: string;
  describe: string;
  migrationsClean: boolean;
  approved: boolean;
}

export async function releaseState(deps: Deps, journal: Journal = loadJournal(deps)) {
  const head = await git(deps, ["rev-parse", "HEAD"]);
  const originMain = await git(deps, ["rev-parse", "refs/remotes/origin/main"]);
  const describe = await git(deps, ["describe", "--always", "--dirty"]);
  const migrations = await git(deps, [
    "status",
    "--porcelain",
    "--ignored",
    "packages/database/migrations",
  ]);
  return {
    head,
    originMain,
    describe,
    migrationsClean: migrations === "",
    approved: journal.approved.some((a) => a.sha === head),
  } satisfies ReleaseState;
}

/** The failures of invariant 3, in words. Empty when the tree may be released. */
export function releaseStateProblems(s: ReleaseState): string[] {
  const problems: string[] = [];
  if (s.head !== s.originMain) {
    problems.push("HEAD is not origin/main (git fetch, then check out main at origin/main)");
  }
  if (!s.approved) {
    problems.push(
      "HEAD is not in the journal's approved SHAs (nov1 approve-sha <sha> --go <gate>)",
    );
  }
  if (!s.migrationsClean) {
    problems.push("packages/database/migrations has untracked, ignored, or changed files");
  }
  if (s.describe.endsWith("-dirty"))
    problems.push("the working tree is dirty (git describe --dirty)");
  return problems;
}

/** Invariant 3 at execution time. */
export async function assertReleasable(deps: Deps): Promise<ReleaseState> {
  const state = await releaseState(deps);
  const problems = releaseStateProblems(state);
  if (problems.length > 0) throw new Refusal(`not releasable: ${problems.join("; ")}`);
  return state;
}
