/**
 * Read-only git checks (invariant 3), run just before every live action.
 * Local reads only: nothing here fetches.
 */
import { type Deps, Refusal } from "./core.ts";
import { childEnv } from "./env.ts";
import { type Journal, loadJournal } from "./journal.ts";
import {
  approvalCounts,
  approvalGateFrom,
  configPaths,
  isCutoverConfig,
  type Phase,
  parseJsonc,
} from "./phase.ts";

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
  /** The phase the approval was checked for. */
  phase: Phase;
  /** HEAD has an approval that counts in this phase (phase-forward). */
  approved: boolean;
  /** Every approval HEAD has, whether or not it counts in this phase. */
  approvals: { gate: string; frozen: boolean }[];
}

export async function releaseState(deps: Deps, phase: Phase, journal: Journal = loadJournal(deps)) {
  const head = await git(deps, ["rev-parse", "HEAD"]);
  const originMain = await git(deps, ["rev-parse", "refs/remotes/origin/main"]);
  const describe = await git(deps, ["describe", "--always", "--dirty"]);
  const migrations = await git(deps, [
    "status",
    "--porcelain",
    "--ignored",
    "packages/database/migrations",
  ]);
  const mine = journal.approved.filter((a) => a.sha === head);
  return {
    head,
    originMain,
    describe,
    migrationsClean: migrations === "",
    phase,
    approved: mine.some((a) => approvalCounts(a, phase)),
    approvals: mine.map((a) => ({ gate: a.gate, frozen: a.frozen === true })),
  } satisfies ReleaseState;
}

/** Why HEAD's approval does not count in this phase, in words. */
export function approvalProblem(s: ReleaseState): string {
  const at = s.phase.toUpperCase();
  if (s.approvals.length === 0)
    return "HEAD is not in the journal's approved SHAs (nov1 approve-sha <sha> --go <gate>)";
  const later = s.approvals.map(({ gate, frozen }) => {
    if (gate === "P0.1" && !frozen)
      return "approved under P0.1 without --frozen, which counts nowhere (nov1 approve-sha <sha> --frozen)";
    const from = approvalGateFrom(gate);
    return from
      ? `approved under ${gate}, which counts from ${from.toUpperCase()} on, not in ${at}`
      : `approved under ${gate}, which is not an approval gate`;
  });
  return `HEAD is ${later.join("; and ")} (an approval counts from its gate's phase on)`;
}

/** The failures of invariant 3, in words. Empty when the tree may be released. */
export function releaseStateProblems(s: ReleaseState): string[] {
  const problems: string[] = [];
  if (s.head !== s.originMain) {
    problems.push("HEAD is not origin/main (git fetch, then check out main at origin/main)");
  }
  if (!s.approved) problems.push(approvalProblem(s));
  if (!s.migrationsClean) {
    problems.push("packages/database/migrations has untracked, ignored, or changed files");
  }
  if (s.describe.endsWith("-dirty"))
    problems.push("the working tree is dirty (git describe --dirty)");
  return problems;
}

/** Invariant 3 at execution time, for the phase the step runs in. */
export async function assertReleasable(deps: Deps, phase: Phase): Promise<ReleaseState> {
  const state = await releaseState(deps, phase);
  const problems = releaseStateProblems(state);
  if (problems.length > 0) throw new Refusal(`not releasable: ${problems.join("; ")}`);
  return state;
}

/**
 * The guest config in a commit's tree (`git show <rev>:<path>`), not the
 * working tree. Null when the file is not in that tree or rev does not exist.
 */
export async function committedGuestConfig(deps: Deps, rev: string) {
  const r = await deps.exec("git", ["show", `${rev}:${configPaths.guest}`], {
    cwd: deps.repoRoot,
    env: childEnv(deps),
    stdio: "pipe",
  });
  if (r.code !== 0) return null;
  return parseJsonc(r.stdout) as Parameters<typeof isCutoverConfig>[0]["guest"];
}

export async function committedIsCutover(deps: Deps, rev: string): Promise<boolean> {
  const guest = await committedGuestConfig(deps, rev);
  return guest !== null && isCutoverConfig({ api: {}, guest });
}

/**
 * The merge that carries C4 into `head`: on head's first-parent history, the
 * latest commit whose committed guest config is the cutover set while its
 * first parent's is not. Null when head's tree does not carry the cutover.
 */
export async function cutoverMerge(deps: Deps, head: string): Promise<string | null> {
  if (!(await committedIsCutover(deps, head))) return null;
  const touched = (await git(deps, ["rev-list", "--first-parent", head, "--", configPaths.guest]))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const sha of touched) {
    if (!(await committedIsCutover(deps, sha))) return null;
    if (!(await committedIsCutover(deps, `${sha}^1`))) return sha;
  }
  return null;
}
