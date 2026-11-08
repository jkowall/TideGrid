/**
 * CI run fixtures for the CI gate (src/ci-status.ts), and a fake `gh api`
 * that serves them. The two recorded runs are GitHub's answers for real push
 * runs on main, read on 2026-11-08 and trimmed to the fields nov1 reads plus
 * a few neighbors: 7ef50cf (pull request 78's merge, all four jobs green) and
 * dd30fc8 (pull request 71's merge, released on November 6 while its run
 * concluded success with three jobs skipped).
 */
import type { ExecCall } from "./helpers.ts";

export interface RunFixture {
  id: number;
  name: string;
  display_title: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string | null;
  path: string;
  run_attempt: number;
  html_url: string;
  created_at: string;
  run_started_at: string;
  head_repository: { full_name: string };
}

export interface JobFixture {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  run_attempt: number;
  html_url: string;
}

export const sha7ef = "7ef50cfdfb2477395f3a860083ba0e6b709f319a";
export const shaDd3 = "dd30fc8084ce9ab836a889bc31443bbf5eae15c8";

/** Recorded: GET repos/jkowall/TideGrid/actions/workflows/ci.yml/runs?head_sha=7ef50cf... */
export const recorded7ef: RunFixture = {
  id: 42411943087,
  name: "ci",
  display_title: "Merge pull request #78 from jkowall/claude/tidegrid-roadmap-7b8r88",
  event: "push",
  status: "completed",
  conclusion: "success",
  head_sha: sha7ef,
  head_branch: "main",
  path: ".github/workflows/ci.yml",
  run_attempt: 1,
  html_url: "https://github.com/jkowall/TideGrid/actions/runs/42411943087",
  created_at: "2026-11-07T20:37:22Z",
  run_started_at: "2026-11-07T20:37:22Z",
  head_repository: { full_name: "jkowall/TideGrid" },
};

/** Recorded: GET repos/jkowall/TideGrid/actions/runs/42411943087/jobs?filter=latest */
export const recorded7efJobs: JobFixture[] = [
  ["checks", 128521769152],
  ["integration", 128521769387],
  ["console-browser", 128521769417],
  ["browser", 128521769453],
].map(([name, id]) => ({
  id: id as number,
  name: name as string,
  status: "completed",
  conclusion: "success",
  head_sha: sha7ef,
  run_attempt: 1,
  html_url: `https://github.com/jkowall/TideGrid/actions/runs/42411943087/job/${id}`,
}));

/** Recorded: the dd30fc8 push run. Its conclusion is success. */
export const recordedDd3: RunFixture = {
  id: 42142133952,
  name: "ci",
  display_title: "Merge pull request #71 from jkowall/nov1/c6-revert",
  event: "push",
  status: "completed",
  conclusion: "success",
  head_sha: shaDd3,
  head_branch: "main",
  path: ".github/workflows/ci.yml",
  run_attempt: 1,
  html_url: "https://github.com/jkowall/TideGrid/actions/runs/42142133952",
  created_at: "2026-11-06T01:11:25Z",
  run_started_at: "2026-11-06T01:11:25Z",
  head_repository: { full_name: "jkowall/TideGrid" },
};

/** Recorded: its jobs. Only checks ran; the other three were skipped. */
export const recordedDd3Jobs: JobFixture[] = [
  ["checks", 127644764222, "success"],
  ["browser", 127644766016, "skipped"],
  ["integration", 127644766066, "skipped"],
  ["console-browser", 127644766735, "skipped"],
].map(([name, id, conclusion]) => ({
  id: id as number,
  name: name as string,
  status: "completed",
  conclusion: conclusion as string,
  head_sha: shaDd3,
  run_attempt: 1,
  html_url: `https://github.com/jkowall/TideGrid/actions/runs/42142133952/job/${id}`,
}));

/** A run shaped like the recorded ones, with overrides. */
export function runOf(over: Partial<RunFixture> & { head_sha: string }): RunFixture {
  const id = over.id ?? 50000000000 + Number.parseInt(over.head_sha.slice(0, 6), 16);
  return {
    ...recorded7ef,
    display_title: "Merge pull request #99 from jkowall/example",
    created_at: over.created_at ?? "2026-11-08T10:00:00Z",
    run_started_at: over.created_at ?? "2026-11-08T10:00:00Z",
    ...over,
    id,
    html_url: over.html_url ?? `https://github.com/jkowall/TideGrid/actions/runs/${id}`,
  };
}

/** A green dispatch run that tested `sha` by name, started from main at `head`. */
export function dispatchOf(sha: string, head: string, over: Partial<RunFixture> = {}): RunFixture {
  return runOf({
    event: "workflow_dispatch",
    display_title: `ci on ${sha}`,
    head_sha: head,
    created_at: "2026-11-08T11:00:00Z",
    ...over,
  });
}

/** The four jobs of a run, each with the given conclusion unless overridden by name. */
export function jobsOf(
  run: RunFixture,
  over: Partial<Record<string, Partial<JobFixture> | null>> = {},
): JobFixture[] {
  return ["checks", "integration", "browser", "console-browser"].flatMap((name, i) => {
    if (over[name] === null) return [];
    return [
      {
        id: run.id * 10 + i,
        name,
        status: "completed",
        conclusion: "success",
        head_sha: run.head_sha,
        run_attempt: run.run_attempt,
        html_url: `${run.html_url}/job/${run.id * 10 + i}`,
        ...over[name],
      },
    ];
  });
}

export interface GhWorld {
  runs: RunFixture[];
  jobs: Record<number, JobFixture[]>;
  /** gh's exit code for every call, to model GitHub unreachable or gh logged out. */
  exitCode?: number;
  /** Throw from exec, as spawn does when gh is not installed. */
  missing?: boolean;
  /** Raw stdout for every call, to model a garbled answer. */
  stdout?: string;
}

function query(args: readonly string[]): Record<string, string> {
  const q: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f") {
      const [k, ...v] = (args[i + 1] ?? "").split("=");
      q[k as string] = v.join("=");
    }
  }
  return q;
}

/**
 * Answer `gh api -X GET <path> -f k=v ...` from a world, filtering the way
 * GitHub does: head_sha, event, and branch on the runs list.
 */
export function ghFrom(world: GhWorld) {
  return (call: ExecCall) => {
    if (call.cmd !== "gh") return undefined;
    if (world.missing) throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    if (world.exitCode !== undefined) return { code: world.exitCode, stdout: "" };
    if (world.stdout !== undefined) return { code: 0, stdout: world.stdout };
    const path = call.args.find((a) => a.startsWith("repos/")) ?? "";
    const q = query(call.args);
    if (path.endsWith("/actions/workflows/ci.yml/runs")) {
      const runs = world.runs.filter(
        (r) =>
          (!q.head_sha || r.head_sha === q.head_sha) &&
          (!q.event || r.event === q.event) &&
          (!q.branch || r.head_branch === q.branch) &&
          (!q.created || r.created_at >= q.created.replace(/^>=/, "")),
      );
      // GitHub pages the list: per_page rows from page (1-based), with the full count.
      const per = Number(q.per_page ?? 30);
      const page = Number(q.page ?? 1);
      const rows = runs.slice((page - 1) * per, page * per);
      return { code: 0, stdout: JSON.stringify({ total_count: runs.length, workflow_runs: rows }) };
    }
    const jobsPath = /\/actions\/runs\/(\d+)\/jobs$/.exec(path);
    if (jobsPath) {
      const jobs = world.jobs[Number(jobsPath[1])] ?? [];
      return { code: 0, stdout: JSON.stringify({ total_count: jobs.length, jobs }) };
    }
    return { code: 1, stdout: "" };
  };
}

/** A world where `sha` has one green push run on main. */
export function greenWorld(sha: string): GhWorld {
  const run = runOf({ head_sha: sha });
  return { runs: [run], jobs: { [run.id]: jobsOf(run) } };
}

/**
 * The default for fakeDeps: any SHA asked about has a green push run, so the
 * suites written before the CI gate keep testing what they tested. The runs
 * served are remembered, so their jobs list answers too.
 */
const servedRuns = new Map<number, RunFixture>();

export function defaultGh(call: ExecCall) {
  if (call.cmd !== "gh") return undefined;
  const sha = query(call.args).head_sha;
  const world: GhWorld = { runs: [], jobs: {} };
  if (sha) {
    const run = runOf({ head_sha: sha });
    servedRuns.set(run.id, run);
    world.runs.push(run);
  }
  for (const [id, run] of servedRuns) world.jobs[id] = jobsOf(run);
  return ghFrom(world)(call);
}
