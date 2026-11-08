/**
 * The CI gate (proposed in the decision register's 2026-11-07 step 9 entry).
 * approve-sha and release refuse a SHA unless a completed run of ci.yml on
 * main is green on all four jobs, and that run's head, or its commit under
 * test, is the SHA. Five SHAs on November 4, and dd30fc8 on November 6, were
 * released before their push runs finished; dd30fc8's push run concluded
 * success with three of its four jobs skipped, so the run's own conclusion is
 * not enough and every job is read.
 *
 * GitHub is read through the gh CLI's own login (coordinator default D1):
 * nov1 never reads, passes, or prints a token. The child gets the usual
 * allowlisted environment (childEnv), so GH_TOKEN and GITHUB_TOKEN never
 * reach it. When GitHub cannot be read, the step refuses with no override
 * (D2). A green dispatch run counts for the SHA it names (D3).
 */
import { type Deps, Refusal } from "./core.ts";
import { childEnv } from "./env.ts";
import { record } from "./journal.ts";
import { assertArgvSafe } from "./redact.ts";

export const ciRepo = "jkowall/TideGrid";
export const ciWorkflowPath = ".github/workflows/ci.yml";
/** The four jobs step 9 asks for. Each must have run and passed. */
export const ciJobs = ["checks", "integration", "browser", "console-browser"] as const;
/** The dispatch run name ci.yml sets: `run-name: ci on <inputs.sha>`. */
const dispatchTitle = /^ci on ([0-9a-f]{40})$/;
/** The workflow's own name, which a dispatch with a blank input keeps as its run name. */
const workflowName = "ci";
/** GitHub's run and job states. Anything else refuses without echoing it. */
const knownStatus = new Set([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const knownConclusion = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);
/** Pages of 100 runs read per list before refusing as truncated (security review F3). */
const maxPages = 10;

export interface CiRun {
  id: number;
  event: string;
  status: string;
  /** The repository the run's head belongs to; must be ciRepo. */
  head_repository: string | null;
  conclusion: string | null;
  head_sha: string;
  head_branch: string | null;
  display_title: string;
  path: string;
  run_attempt: number;
  html_url: string;
  created_at: string;
  /** When the latest attempt started. A re-run moves it; created_at stays. */
  run_started_at: string | null;
}

export interface CiJob {
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
}

export interface CiPass {
  /** The run's page, for the journal and the owner. */
  url: string;
  /** push: a run on main whose head is the SHA. dispatch: a run that tested the SHA by name. */
  via: "push" | "dispatch";
  attempt: number;
}

const noOverride = "nov1 has no override for this (coordinator default D2)";

async function ghGet(deps: Deps, path: string, query: Record<string, string>): Promise<unknown> {
  // --hostname pins github.com, whatever host gh's login lists first.
  const args = ["api", "--hostname", "github.com", "-X", "GET", path];
  for (const [k, v] of Object.entries(query)) args.push("-f", `${k}=${v}`);
  assertArgvSafe("gh", args);
  let result: Awaited<ReturnType<Deps["exec"]>>;
  try {
    result = await deps.exec("gh", args, {
      cwd: deps.repoRoot,
      // The allowlist only, so no token from the shell reaches gh: it uses its
      // own login. GH_CONFIG_DIR is a path, kept so a moved login still works.
      env: childEnv(deps, {
        GH_CONFIG_DIR: deps.env.GH_CONFIG_DIR || undefined,
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
      }),
      stdio: "pipe",
    });
  } catch {
    throw new Refusal(
      `could not run gh to read CI status from GitHub; install the GitHub CLI and run gh auth login. ${noOverride}`,
    );
  }
  if (result.code !== 0) {
    throw new Refusal(
      `GitHub could not be read (gh api exited ${result.code}), so CI status is unknown; check the network and gh auth status. ${noOverride}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Refusal(
      `GitHub's answer for ${path} was not JSON, so CI status is unknown. ${noOverride}`,
    );
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function listOf(body: unknown, key: string, path: string): Record<string, unknown>[] {
  const list = isObject(body) ? body[key] : undefined;
  if (!Array.isArray(list) || !list.every(isObject)) {
    throw new Refusal(
      `GitHub's answer for ${path} has no ${key} list, so CI status is unknown. ${noOverride}`,
    );
  }
  return list;
}

function asRun(r: Record<string, unknown>): CiRun | null {
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
  const id = typeof r.id === "number" ? r.id : null;
  const attempt = typeof r.run_attempt === "number" ? r.run_attempt : null;
  const [event, status, head, title, path, url, created] = [
    s("event"),
    s("status"),
    s("head_sha"),
    s("display_title"),
    s("path"),
    s("html_url"),
    s("created_at"),
  ];
  if (id === null || attempt === null || !event || !status || !head || title === null) return null;
  if (!path || !url || !created) return null;
  const repo = isObject(r.head_repository) ? r.head_repository.full_name : null;
  return {
    id,
    event,
    status,
    head_repository: typeof repo === "string" ? repo : null,
    conclusion: s("conclusion"),
    head_sha: head,
    head_branch: s("head_branch"),
    display_title: title,
    path,
    run_attempt: attempt,
    html_url: url,
    created_at: created,
    run_started_at: s("run_started_at"),
  };
}

/** The run's page, as GitHub forms it for this repository. Anything else is not trusted. */
export function runUrl(id: number): string {
  return `https://github.com/${ciRepo}/actions/runs/${id}`;
}

/**
 * The commit a run of ci.yml on main tested, or null when the run cannot
 * count. A push run tests its head. A dispatch tests the SHA its name gives
 * (ci.yml's guard step fails every job unless it checked out exactly that
 * full SHA, on main, from main's workflow), or its head when the input was
 * blank. Pull request runs test a merge commit, so they never count.
 */
export function commitUnderTest(run: CiRun): string | null {
  if (run.path !== ciWorkflowPath || run.head_branch !== "main") return null;
  if (run.head_repository?.toLowerCase() !== ciRepo.toLowerCase()) return null;
  if (run.html_url.toLowerCase() !== runUrl(run.id).toLowerCase()) return null;
  if (run.event === "push") return run.head_sha;
  if (run.event === "workflow_dispatch") {
    const named = dispatchTitle.exec(run.display_title);
    if (named) return named[1] as string;
    // A blank input keeps the workflow's name and tests the checked-out head.
    return run.display_title === workflowName ? run.head_sha : null;
  }
  return null;
}

/** When the run's latest word was given: its latest attempt's start, else its creation. */
const startedAt = (r: CiRun) => r.run_started_at ?? r.created_at;

/**
 * The runs that tested `sha`, newest first by their latest attempt's start.
 * The first that started decides (coordinator default D4): a newer run in
 * progress, or a newer failure, refuses even when an older run passed. A run
 * cancelled before any job started (a duplicate dispatch GitHub dropped from
 * its concurrency group) said nothing about the SHA, so ciStatus skips it.
 */
export function candidateRuns(runs: readonly CiRun[], sha: string): CiRun[] {
  return runs
    .filter((r) => commitUnderTest(r) === sha)
    .sort((a, b) => startedAt(b).localeCompare(startedAt(a)) || b.id - a.id);
}

/** The newest run that tested `sha`, before skipping runs that never started. */
export function selectRun(runs: readonly CiRun[], sha: string): CiRun | undefined {
  return candidateRuns(runs, sha)[0];
}

/** Why the run's jobs do not pass, in words. Empty when all four ran and passed. */
export function jobProblems(jobs: readonly CiJob[], run: CiRun): string[] {
  const problems: string[] = [];
  for (const name of ciJobs) {
    const mine = jobs.filter((j) => j.name === name);
    const job = mine[0];
    if (!job) problems.push(`${name} did not run`);
    else if (mine.length > 1) problems.push(`${name} appears ${mine.length} times`);
    else if (job.head_sha !== run.head_sha) problems.push(`${name} ran on another head`);
    else if (job.status !== "completed")
      problems.push(
        `${name} is ${knownStatus.has(job.status) ? job.status : "in an unknown state"}`,
      );
    else if (job.conclusion !== "success")
      problems.push(
        `${name} ${job.conclusion && knownConclusion.has(job.conclusion) ? job.conclusion : "has no known conclusion"}`,
      );
  }
  return problems;
}

function asJob(j: Record<string, unknown>): CiJob | null {
  const s = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : null);
  const [name, status, head] = [s("name"), s("status"), s("head_sha")];
  if (!name || !status || !head) return null;
  return { name, status, conclusion: s("conclusion"), head_sha: head };
}

/** Every row of a runs list, page by page; refuses when the list is longer than maxPages pages. */
async function allRuns(
  deps: Deps,
  query: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const path = `repos/${ciRepo}/actions/workflows/ci.yml/runs`;
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await ghGet(deps, path, { ...query, per_page: "100", page: String(page) });
    const list = listOf(body, "workflow_runs", path);
    rows.push(...list);
    const total = isObject(body) && typeof body.total_count === "number" ? body.total_count : null;
    if (list.length < 100 || (total !== null && rows.length >= total)) return rows;
  }
  throw new Refusal(
    `more than ${maxPages * 100} runs match on GitHub, so the newest run for the SHA cannot be known. ${noOverride}`,
  );
}

async function jobsOf(deps: Deps, run: CiRun): Promise<CiJob[]> {
  const path = `repos/${ciRepo}/actions/runs/${run.id}/jobs`;
  const rows = listOf(await ghGet(deps, path, { filter: "latest", per_page: "100" }), "jobs", path);
  const jobs = rows.map(asJob);
  // A record that cannot be read proves nothing, least of all that no job started.
  if (jobs.some((j) => j === null)) {
    throw new Refusal(
      `GitHub's jobs for ${runUrl(run.id)} include a record nov1 cannot read. ${noOverride}`,
    );
  }
  return jobs as CiJob[];
}

/**
 * Whether `commit` is on origin/main here: true, false (known, not on main,
 * such as a tag named main), or a Refusal when this clone does not have the
 * commit at all (exit 128), since a stale clone must not hide a newer run.
 */
async function onMain(deps: Deps, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(commit)) return false;
  let r: Awaited<ReturnType<Deps["exec"]>>;
  try {
    r = await deps.exec(
      "git",
      ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
      {
        cwd: deps.repoRoot,
        env: childEnv(deps),
        stdio: "pipe",
      },
    );
  } catch {
    throw new Refusal("git could not be run to place a CI run's head on origin/main");
  }
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Refusal(
    `a CI run's head ${commit.slice(0, 12)} is not in this clone, so whether it ran main's workflow is unknown: git fetch origin, then retry`,
  );
}

/**
 * The earliest time a dispatch could have tested `sha`: a day before its
 * committer date, for clock skew. It bounds the dispatch query, so old
 * dispatches never fill GitHub's 1,000-run cap (security recheck).
 */
async function dispatchWindow(deps: Deps, sha: string): Promise<string> {
  const r = await deps.exec("git", ["show", "-s", "--format=%ct", sha], {
    cwd: deps.repoRoot,
    env: childEnv(deps),
    stdio: "pipe",
  });
  const seconds = Number.parseInt(r.stdout.trim(), 10);
  if (r.code !== 0 || !Number.isFinite(seconds)) {
    throw new Refusal(
      `git could not read ${sha.slice(0, 12)}'s commit date: git fetch origin, then retry`,
    );
  }
  return new Date((seconds - 86_400) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Read GitHub and decide. Returns the passing run, or throws a Refusal that
 * names the run and what is missing. Read-only: nothing is triggered.
 */
export async function ciStatus(deps: Deps, sha: string): Promise<CiPass> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Refusal(`the CI gate needs a full SHA, not ${sha}`);
  const byHead = await allRuns(deps, { head_sha: sha });
  // A dispatch for an older SHA has main's head at the time, so its name is what links it.
  const dispatches = await allRuns(deps, {
    event: "workflow_dispatch",
    branch: "main",
    created: `>=${await dispatchWindow(deps, sha)}`,
  });
  const parsed = [...byHead, ...dispatches].map(asRun);
  // A row that cannot be read might be the newest word on the SHA, so it refuses.
  if (parsed.some((r) => r === null)) {
    throw new Refusal(`GitHub's runs list includes a run nov1 cannot read. ${noOverride}`);
  }
  // One entry per run: its highest attempt, the later observation on a tie.
  const byId = new Map<number, CiRun>();
  for (const r of parsed as CiRun[]) {
    const seen = byId.get(r.id);
    if (!seen || r.run_attempt >= seen.run_attempt) byId.set(r.id, r);
  }
  const runs = [...byId.values()];
  const short = sha.slice(0, 12);
  const none = `no CI run of ci.yml on main has tested ${short}: wait for its push run, or have the owner dispatch one (gh workflow run ci.yml --ref main -f sha=${sha})`;
  for (const run of candidateRuns(runs, sha)) {
    // A dispatch runs the workflow file at its head. Only a head on main
    // carries main's guard step (security review F1: a tag named main), so a
    // dispatch whose head is not on origin/main here never counts as a pass.
    // It still blocks when it is not green: a stale origin/main could make a
    // real dispatch look off main, and a newer failure must not be skipped.
    const trusted = run.event !== "workflow_dispatch" || (await onMain(deps, run.head_sha));
    if (!knownStatus.has(run.status)) {
      throw new Refusal(`the newest CI run for ${short} is in an unknown state: ${runUrl(run.id)}`);
    }
    if (run.status !== "completed") {
      throw new Refusal(
        `the newest CI run for ${short} is ${run.status}: ${runUrl(run.id)}. Wait for it to finish.`,
      );
    }
    const jobs =
      run.conclusion === "success" || run.conclusion === "cancelled" ? await jobsOf(deps, run) : [];
    if (run.conclusion === "cancelled" && jobs.length === 0) continue;
    if (run.conclusion !== "success") {
      const said =
        run.conclusion && knownConclusion.has(run.conclusion) ? run.conclusion : "nothing known";
      throw new Refusal(`the newest CI run for ${short} concluded ${said}: ${runUrl(run.id)}`);
    }
    const problems = jobProblems(jobs, run);
    if (problems.length > 0) {
      throw new Refusal(
        `the newest CI run for ${short} is not green on all four jobs (${problems.join("; ")}): ${runUrl(run.id)}`,
      );
    }
    if (!trusted) continue;
    return {
      url: runUrl(run.id),
      via: run.event === "push" ? "push" : "dispatch",
      attempt: run.run_attempt,
    };
  }
  throw new Refusal(none);
}

/**
 * The gate itself: decide, journal the decision with the run's URL, and
 * rethrow a refusal after journaling it. The journal entry is step "ci-check".
 */
export async function assertCiGreen(
  deps: Deps,
  sha: string,
  where: { phase: string; gate: string; command: "approve-sha" | "release" },
): Promise<CiPass> {
  try {
    const pass = await ciStatus(deps, sha);
    record(deps, {
      phase: where.phase,
      step: "ci-check",
      gate: where.gate,
      sha,
      result: "done",
      note: `${where.command}: ${pass.url} (${pass.via} run, attempt ${pass.attempt}), ${ciJobs.join(", ")} green`,
    });
    return pass;
  } catch (e) {
    if (e instanceof Refusal) {
      record(deps, {
        phase: where.phase,
        step: "ci-check",
        gate: where.gate,
        sha,
        result: "refused",
        note: `${where.command}: ${e.message}`,
      });
    }
    throw e;
  }
}
