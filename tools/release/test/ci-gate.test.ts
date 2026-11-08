/**
 * The CI gate (src/ci-status.ts): approve-sha and release refuse a SHA unless
 * a completed ci.yml run on main is green on all four jobs and its head, or
 * its commit under test, is that SHA. GitHub is read through gh's own login;
 * no token is read, passed, printed, or journaled.
 */
import { describe, expect, it } from "vitest";
import { type CiRun, commitUnderTest, selectRun } from "../src/ci-status.ts";
import { main } from "../src/cli.ts";
import { treeMigrations } from "../src/commands/preflight.ts";
import type { Deps } from "../src/core.ts";
import { loadJournal, saveJournal } from "../src/journal.ts";
import {
  dispatchOf,
  type GhWorld,
  ghFrom,
  greenWorld,
  type JobFixture,
  jobsOf,
  type RunFixture,
  recorded7ef,
  recorded7efJobs,
  recordedDd3,
  recordedDd3Jobs,
  runOf,
  sha7ef,
  shaDd3,
} from "./ci-fixtures.ts";
import { type ExecCall, fakeDeps, headSha, json, repoRoot } from "./helpers.ts";

const treeLatest = treeMigrations(repoRoot).at(-1) ?? "";
const twelve = headSha.slice(0, 12);
const approveArgv = ["approve-sha", headSha, "--go", "A3"];
const releaseApi = ["release", "api", "--phase", "p3", "--live", "--go", "A4"];
const older = "c".repeat(40);

/** Fake deps whose gh answers from `world` and whose git names `sha` as HEAD. */
function withWorld(world: GhWorld, o: Parameters<typeof fakeDeps>[0] = {}) {
  let deployed = false;
  const gh = ghFrom(world);
  return fakeDeps({
    answers: [twelve, "tidegrid-api"],
    ...o,
    exec: (c) => {
      if (c.cmd === "pnpm" && c.args.includes("release")) deployed = true;
      return o.exec?.(c) ?? gh(c);
    },
    fetch: (c) =>
      c.url.endsWith("/v1/health")
        ? json(200, {
            version: deployed ? "aaaaaaa" : "old",
            database: "ok",
            migrations: { latest: treeLatest },
          })
        : undefined,
  });
}

/** A release types only the Worker's name back. */
const typedRelease = { answers: ["tidegrid-api"] };

function frozen(deps: Deps) {
  const j = loadJournal(deps);
  j.approved.push({ sha: headSha, tree: "t", gate: "P0.1", at: "x", frozen: true });
  saveJournal(deps, j);
}

const ciEntries = (deps: Deps) => loadJournal(deps).entries.filter((e) => e.step === "ci-check");
const ghCalls = (execs: ExecCall[]) => execs.filter((e) => e.cmd === "gh");
const deploys = (execs: ExecCall[]) =>
  execs.filter((e) => e.cmd === "pnpm" && e.args.includes("release"));

/** Each world refuses, for both commands, with a message matching `why`. */
const refusals: [string, () => GhWorld, RegExp][] = [
  [
    "no run",
    () => ({ runs: [], jobs: {} }),
    /no CI run of ci\.yml on main has tested aaaaaaaaaaaa/,
  ],
  [
    "a run in progress",
    () => {
      const run = runOf({ head_sha: headSha, status: "in_progress", conclusion: null });
      return { runs: [run], jobs: { [run.id]: jobsOf(run) } };
    },
    /is in_progress: https:\/\/github\.com\/jkowall\/TideGrid\/actions\/runs\/\d+\. Wait/,
  ],
  [
    "a queued run",
    () => {
      const run = runOf({ head_sha: headSha, status: "queued", conclusion: null });
      return { runs: [run], jobs: {} };
    },
    /is queued/,
  ],
  [
    "a run that failed",
    () => {
      const run = runOf({ head_sha: headSha, conclusion: "failure" });
      return {
        runs: [run],
        jobs: { [run.id]: jobsOf(run, { browser: { conclusion: "failure" } }) },
      };
    },
    /concluded failure/,
  ],
  [
    "a cancelled run",
    () => {
      const run = runOf({ head_sha: headSha, conclusion: "cancelled" });
      return { runs: [run], jobs: { [run.id]: jobsOf(run) } };
    },
    /concluded cancelled/,
  ],
  ...(["checks", "integration", "browser", "console-browser"] as const).flatMap(
    (job): [string, () => GhWorld, RegExp][] => [
      [
        `${job} failed under a run marked success`,
        () => {
          const run = runOf({ head_sha: headSha });
          return {
            runs: [run],
            jobs: { [run.id]: jobsOf(run, { [job]: { conclusion: "failure" } }) },
          };
        },
        new RegExp(`not green on all four jobs \\(${job} failure\\)`),
      ],
      [
        `${job} skipped`,
        () => {
          const run = runOf({ head_sha: headSha });
          return {
            runs: [run],
            jobs: { [run.id]: jobsOf(run, { [job]: { conclusion: "skipped" } }) },
          };
        },
        new RegExp(`\\(${job} skipped\\)`),
      ],
      [
        `${job} missing`,
        () => {
          const run = runOf({ head_sha: headSha });
          return { runs: [run], jobs: { [run.id]: jobsOf(run, { [job]: null }) } };
        },
        new RegExp(`\\(${job} did not run\\)`),
      ],
    ],
  ),
  [
    "a job still running in a completed run's latest attempt",
    () => {
      const run = runOf({ head_sha: headSha });
      return {
        runs: [run],
        jobs: { [run.id]: jobsOf(run, { checks: { status: "in_progress", conclusion: null } }) },
      };
    },
    /checks is in_progress/,
  ],
  [
    "a job that ran on another head",
    () => {
      const run = runOf({ head_sha: headSha });
      return { runs: [run], jobs: { [run.id]: jobsOf(run, { integration: { head_sha: older } }) } };
    },
    /integration ran on another head/,
  ],
  [
    "a run whose head is another SHA (GitHub ignoring the filter)",
    () => {
      // ghFrom filters by head_sha, so serve the wrong run through stdout.
      const run = runOf({ head_sha: older });
      return {
        runs: [],
        jobs: {},
        stdout: JSON.stringify({ workflow_runs: [run], jobs: jobsOf(run) }),
      };
    },
    /no CI run of ci\.yml on main has tested/,
  ],
  [
    "a pull request run whose head is the SHA",
    () => {
      const run = runOf({ head_sha: headSha, event: "pull_request", head_branch: "feature" });
      return { runs: [run], jobs: { [run.id]: jobsOf(run) } };
    },
    /no CI run/,
  ],
  [
    "a push run on another branch",
    () => {
      const run = runOf({ head_sha: headSha, head_branch: "release" });
      return { runs: [run], jobs: { [run.id]: jobsOf(run) } };
    },
    /no CI run/,
  ],
  [
    "a run of another workflow file",
    () => {
      const run = runOf({ head_sha: headSha, path: ".github/workflows/other.yml" });
      return { runs: [run], jobs: { [run.id]: jobsOf(run) } };
    },
    /no CI run/,
  ],
  [
    "a dispatch that tested another SHA",
    () => {
      const run = dispatchOf(older, headSha);
      return { runs: [run], jobs: { [run.id]: jobsOf(run) } };
    },
    /no CI run/,
  ],
  [
    "a dispatch named with a short SHA",
    () => {
      const run = dispatchOf(headSha, older, { display_title: `ci on ${twelve}` });
      return { runs: [run], jobs: { [run.id]: jobsOf(run) } };
    },
    /no CI run/,
  ],
  [
    "a newer run in progress after an older green one",
    () => {
      const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T10:00:00Z" });
      const again = dispatchOf(headSha, older, {
        id: 2,
        status: "in_progress",
        conclusion: null,
        created_at: "2026-11-08T12:00:00Z",
      });
      return { runs: [green, again], jobs: { 1: jobsOf(green), 2: [] } };
    },
    /newest CI run for aaaaaaaaaaaa is in_progress: .*\/runs\/2\./,
  ],
  [
    "GitHub unreachable (gh exits non-zero)",
    () => ({ runs: [], jobs: {}, exitCode: 1 }),
    /GitHub could not be read \(gh api exited 1\).*no override/,
  ],
  [
    "gh logged out (exit 4)",
    () => ({ runs: [], jobs: {}, exitCode: 4 }),
    /gh api exited 4.*gh auth status/,
  ],
  [
    "gh not installed",
    () => ({ runs: [], jobs: {}, missing: true }),
    /could not run gh.*gh auth login.*no override/,
  ],
  [
    "an answer that is not JSON",
    () => ({ runs: [], jobs: {}, stdout: "<html>rate limited</html>" }),
    /was not JSON/,
  ],
  [
    "an answer with no runs list",
    () => ({ runs: [], jobs: {}, stdout: JSON.stringify({ message: "Not Found" }) }),
    /has no workflow_runs list/,
  ],
];

describe("approve-sha refuses without a green four-job CI run", () => {
  for (const [name, world, why] of refusals) {
    it(`refuses ${name}, before the owner types, and journals the refusal`, async () => {
      const { deps, printed, prompts } = withWorld(world());
      expect(await main(approveArgv, deps)).toBe(3);
      expect(printed.join("\n")).toMatch(why);
      expect(prompts).toEqual([]);
      const j = loadJournal(deps);
      expect(j.approved).toEqual([]);
      expect(j.entries).toMatchObject([
        { step: "ci-check", result: "refused", sha: headSha, gate: "A3", phase: "p3" },
      ]);
      expect(j.entries[0]?.note).toMatch(/^approve-sha: /);
    });
  }

  it("refuses dd30fc8's recorded push run: success overall, three jobs skipped", async () => {
    const world = { runs: [recordedDd3], jobs: { [recordedDd3.id]: recordedDd3Jobs } };
    const { deps, printed } = withWorld(world, {
      exec: (c) =>
        c.cmd === "git" && c.args[0] === "rev-parse" && c.args[1] === "--verify"
          ? { code: 0, stdout: `${shaDd3}\n` }
          : undefined,
      answers: [shaDd3.slice(0, 12)],
    });
    expect(await main(["approve-sha", shaDd3, "--go", "A3"], deps)).toBe(3);
    expect(printed.join("\n")).toContain(
      "not green on all four jobs (integration skipped; browser skipped; console-browser skipped): https://github.com/jkowall/TideGrid/actions/runs/42142133952",
    );
  });
});

describe("approve-sha accepts", () => {
  it("7ef50cf's recorded push run, and journals the decision with the run's URL", async () => {
    const world = { runs: [recorded7ef], jobs: { [recorded7ef.id]: recorded7efJobs } };
    const { deps, printed, execs } = withWorld(world, {
      exec: (c) =>
        c.cmd === "git" && c.args[0] === "rev-parse" && c.args[1] === "--verify"
          ? { code: 0, stdout: `${sha7ef}\n` }
          : undefined,
      answers: [sha7ef.slice(0, 12)],
    });
    expect(await main(["approve-sha", sha7ef, "--frozen"], deps)).toBe(0);
    expect(printed.at(-1)).toMatch(
      /approved 7ef50cf.* under P0\.1; .*CI: https:\/\/github\.com\/jkowall\/TideGrid\/actions\/runs\/42411943087$/,
    );
    const j = loadJournal(deps);
    expect(j.approved).toMatchObject([{ sha: sha7ef, gate: "P0.1", frozen: true }]);
    expect(j.entries).toEqual([
      {
        at: expect.any(String),
        phase: "p0",
        step: "ci-check",
        gate: "P0.1",
        sha: sha7ef,
        result: "done",
        note: "approve-sha: https://github.com/jkowall/TideGrid/actions/runs/42411943087 (push run, attempt 1), checks, integration, browser, console-browser green",
      },
    ]);
    // The ancestry check ran before GitHub was asked.
    const order = execs.map((e) => `${e.cmd} ${e.args[0]}`);
    expect(order.indexOf("git merge-base")).toBeLessThan(order.indexOf("gh api"));
  });

  it("a green dispatch run that names an older SHA (D3)", async () => {
    const run = dispatchOf(headSha, older);
    const { deps, printed } = withWorld({ runs: [run], jobs: { [run.id]: jobsOf(run) } });
    expect(await main(approveArgv, deps)).toBe(0);
    expect(printed.at(-1)).toContain(`CI: ${run.html_url}`);
    expect(ciEntries(deps)).toMatchObject([
      { result: "done", note: expect.stringContaining("(dispatch run, attempt 1)") },
    ]);
  });

  it("a newer green dispatch after a failed push run: the newest run decides", async () => {
    const failed = runOf({ head_sha: headSha, id: 1, conclusion: "failure" });
    const again = dispatchOf(headSha, older, { id: 2 });
    const { deps } = withWorld({
      runs: [failed, again],
      jobs: { 1: jobsOf(failed, { browser: { conclusion: "failure" } }), 2: jobsOf(again) },
    });
    expect(await main(approveArgv, deps)).toBe(0);
    expect(ciEntries(deps)[0]?.note).toContain("/runs/2 ");
  });
});

describe("approve-sha keeps its earlier checks", () => {
  it("refuses a SHA not on origin/main before asking GitHub", async () => {
    const { deps, execs, printed } = withWorld(greenWorld(headSha), {
      exec: (c) => (c.args[0] === "merge-base" ? { code: 1, stdout: "" } : undefined),
    });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/not on origin\/main/);
    expect(ghCalls(execs)).toEqual([]);
    expect(loadJournal(deps).entries).toEqual([]);
  });

  it("refuses under CI, or with no terminal, before asking GitHub", async () => {
    for (const o of [{ env: { CI: "1" } }, { tty: false }]) {
      const { deps, execs } = withWorld(greenWorld(headSha), o);
      expect(await main(approveArgv, deps)).toBe(3);
      expect(ghCalls(execs)).toEqual([]);
    }
  });

  it("still refuses a mistyped SHA after CI passes, and records no approval", async () => {
    const { deps, printed } = withWorld(greenWorld(headSha), { answers: ["bbbbbbbbbbbb"] });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/typed SHA did not match/);
    expect(loadJournal(deps).approved).toEqual([]);
  });
});

describe("release refuses without a green four-job CI run", () => {
  for (const [name, world, why] of refusals) {
    it(`refuses ${name}, and deploys nothing`, async () => {
      const { deps, printed, execs } = withWorld(world(), typedRelease);
      frozen(deps);
      expect(await main(releaseApi, deps)).toBe(3);
      expect(printed.join("\n")).toMatch(why);
      expect(deploys(execs)).toEqual([]);
      expect(ciEntries(deps)).toMatchObject([
        { result: "refused", sha: headSha, gate: "A4", phase: "p3" },
      ]);
      expect(ciEntries(deps)[0]?.note).toMatch(/^release: /);
      expect(loadJournal(deps).entries.filter((e) => e.step === "release")).toEqual([]);
    });
  }

  it("still refuses an unapproved HEAD before asking GitHub", async () => {
    const { deps, execs, printed } = withWorld(greenWorld(headSha), typedRelease);
    expect(await main(releaseApi, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/not in the journal's approved SHAs/);
    expect(ghCalls(execs)).toEqual([]);
  });
});

describe("release accepts", () => {
  it("a green push run on main for HEAD, journaled before the release starts", async () => {
    const { deps, execs } = withWorld(greenWorld(headSha), typedRelease);
    frozen(deps);
    expect(await main(releaseApi, deps)).toBe(0);
    expect(deploys(execs)).toHaveLength(1);
    const steps = loadJournal(deps).entries.map((e) => `${e.step}:${e.result}`);
    expect(steps.slice(0, 2)).toEqual(["ci-check:done", "release:started"]);
    expect(ciEntries(deps)[0]?.note).toMatch(
      /^release: https:\/\/github\.com\/.*\(push run, attempt 1\)/,
    );
  });

  it("a green dispatch run for HEAD", async () => {
    const run = dispatchOf(headSha, older);
    const { deps, execs } = withWorld(
      { runs: [run], jobs: { [run.id]: jobsOf(run) } },
      typedRelease,
    );
    frozen(deps);
    expect(await main(releaseApi, deps)).toBe(0);
    expect(deploys(execs)).toHaveLength(1);
  });

  it("a rollback, without asking GitHub: it deploys a recorded version, not this tree", async () => {
    const v = (n: number) => `${String(n).repeat(8)}-2222-4333-8444-555555555555`;
    const listing = (id: string) => ({
      code: 0,
      stdout: JSON.stringify([{ versions: [{ version_id: id }] }]),
    });
    let rolled = false;
    const gh = ghFrom({ runs: [], jobs: {}, missing: true });
    const { deps, execs, printed } = fakeDeps({
      answers: ["tidegrid-api", v(1).slice(0, 8), "yes"],
      exec: (c) => {
        if (c.cmd === "gh") return gh(c);
        if (c.args.includes("rollback")) {
          rolled = true;
          return { code: 0, stdout: "" };
        }
        if (c.args.includes("deployments")) return listing(rolled ? v(1) : v(2));
        return undefined;
      },
    });
    const j = loadJournal(deps);
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
    saveJournal(deps, j);
    const argv = ["release", "api", "--phase", "p7", "--rollback", "--live", "--go", "A8"];
    expect(await main(argv, deps), printed.join("\n")).toBe(0);
    expect(ghCalls(execs)).toEqual([]);
    expect(ciEntries(deps)).toEqual([]);
  });

  it("--verify, without asking GitHub: it deploys nothing", async () => {
    const { deps, execs } = withWorld({ runs: [], jobs: {}, missing: true }, typedRelease);
    frozen(deps);
    // The fake health reports an older build, so the re-check fails (exit 1), not refuses.
    expect(await main([...releaseApi, "--verify"], deps)).toBe(1);
    expect(loadJournal(deps).entries.map((e) => e.step)).toEqual(["release-verify"]);
    expect(ghCalls(execs)).toEqual([]);
  });
});

describe("gh runs with its own login and no token from nov1 (D1)", () => {
  const token = `ghp_${"Z".repeat(36)}`;
  const env = { GH_TOKEN: token, GITHUB_TOKEN: token, GH_ENTERPRISE_TOKEN: token };

  it("passes no token-bearing name to gh, puts no token in argv, and prints or journals none", async () => {
    const { deps, execs, printed } = withWorld(greenWorld(headSha), { env });
    expect(await main(approveArgv, deps)).toBe(0);
    frozen(deps);
    expect(await main(releaseApi, deps)).toBe(0);
    const gh = ghCalls(execs);
    expect(gh.length).toBeGreaterThanOrEqual(4);
    for (const call of gh) {
      expect(call.args.join(" ")).not.toContain(token);
      expect(
        Object.keys(call.options.env)
          .filter((k) => /TOKEN|GH_|GITHUB/.test(k))
          .sort(),
      ).toEqual(["GH_NO_UPDATE_NOTIFIER", "GH_PROMPT_DISABLED"]);
      expect(Object.values(call.options.env)).not.toContain(token);
      expect(call.options.stdio).toBe("pipe");
      expect(call.args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "-X", "GET"]);
    }
    expect(printed.join("\n")).not.toContain(token);
    expect(JSON.stringify(loadJournal(deps))).not.toContain(token);
  });

  it("keeps GH_CONFIG_DIR, a path, so a moved gh login still works", async () => {
    const { deps, execs } = withWorld(greenWorld(headSha), {
      env: { GH_CONFIG_DIR: "/home/owner/.config/gh-alt" },
    });
    expect(await main(approveArgv, deps)).toBe(0);
    for (const call of ghCalls(execs))
      expect(call.options.env.GH_CONFIG_DIR).toBe("/home/owner/.config/gh-alt");
  });

  it("asks only read-only endpoints of the one repository", async () => {
    const { deps, execs } = withWorld(greenWorld(headSha));
    expect(await main(approveArgv, deps)).toBe(0);
    for (const call of ghCalls(execs)) {
      expect(call.args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "-X", "GET"]);
      expect(call.args[5]).toMatch(
        /^repos\/jkowall\/TideGrid\/actions\/(workflows\/ci\.yml\/runs|runs\/\d+\/jobs)$/,
      );
      expect(call.args).not.toContain("POST");
      expect(call.args.join(" ")).not.toMatch(/dispatches|rerun|workflow run/);
    }
  });
});

/** A fixture as ciStatus reads it. */
const asCi = (r: RunFixture): CiRun => ({ ...r, head_repository: r.head_repository.full_name });

describe("run selection", () => {
  it("reads the commit under test from a dispatch's name, or its head when the input was blank", () => {
    expect(commitUnderTest(asCi(dispatchOf(headSha, older)))).toBe(headSha);
    expect(commitUnderTest(asCi(dispatchOf(headSha, older, { display_title: "ci" })))).toBe(older);
    // Any other name is not the workflow's default, so it names nothing.
    expect(
      commitUnderTest(asCi(dispatchOf(headSha, older, { display_title: `ci on ${twelve}` }))),
    ).toBeNull();
    expect(
      commitUnderTest(asCi(dispatchOf(headSha, older, { display_title: "Merge pull request #1" }))),
    ).toBeNull();
    expect(
      commitUnderTest(asCi(dispatchOf(headSha, older, { head_branch: "feature" }))),
    ).toBeNull();
    expect(commitUnderTest(asCi(runOf({ head_sha: headSha })))).toBe(headSha);
    expect(commitUnderTest(asCi(runOf({ head_sha: headSha, event: "schedule" })))).toBeNull();
  });

  it("counts only runs of this repository whose page is where GitHub puts it", () => {
    const fork = runOf({ head_sha: headSha, head_repository: { full_name: "someone/TideGrid" } });
    expect(commitUnderTest(asCi(fork))).toBeNull();
    const elsewhere = runOf({ head_sha: headSha, html_url: "https://example.test/runs/1" });
    expect(commitUnderTest(asCi(elsewhere))).toBeNull();
    const cased = runOf({ head_sha: headSha });
    expect(commitUnderTest(asCi({ ...cased, html_url: cased.html_url.toLowerCase() }))).toBe(
      headSha,
    );
  });

  it("picks the run whose latest attempt started last, so a re-run is the newest word", () => {
    const a = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const b = dispatchOf(headSha, older, { id: 2, created_at: "2026-11-08T10:00:00Z" });
    const c = runOf({ head_sha: older, id: 3, created_at: "2026-11-08T11:00:00Z" });
    expect(selectRun([a, b, c].map(asCi), headSha)?.id).toBe(2);
    expect(selectRun([asCi(c)], headSha)).toBeUndefined();
    const rerun = { ...a, run_started_at: "2026-11-08T12:00:00Z", run_attempt: 2 };
    expect(selectRun([rerun, b].map(asCi), headSha)?.id).toBe(1);
  });
});

describe("review fixes", () => {
  it("skips a duplicate dispatch cancelled before any job ran (recorded shape, 9086a18 on 2026-11-08)", async () => {
    const sha = "9086a1812ee943d6056a3bfccb206bba3fbbc85d";
    const head = "f72b1bd3f3bd177be7bfcd59643aefea7853bb45";
    const green = dispatchOf(sha, head, {
      id: 42432178347,
      created_at: "2026-11-08T00:58:30Z",
    });
    const dropped = dispatchOf(sha, head, {
      id: 42432272795,
      conclusion: "cancelled",
      created_at: "2026-11-08T00:59:55Z",
    });
    const { deps, printed } = withWorld(
      { runs: [green, dropped], jobs: { [green.id]: jobsOf(green), [dropped.id]: [] } },
      {
        exec: (c) =>
          c.cmd === "git" && c.args[0] === "rev-parse" && c.args[1] === "--verify"
            ? { code: 0, stdout: `${sha}\n` }
            : undefined,
        answers: [sha.slice(0, 12)],
      },
    );
    expect(await main(["approve-sha", sha, "--go", "A3"], deps), printed.join("\n")).toBe(0);
    expect(ciEntries(deps)[0]?.note).toContain("/runs/42432178347 (dispatch run");
  });

  it("still refuses a newer cancelled run whose jobs had started", async () => {
    const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const stopped = dispatchOf(headSha, older, { id: 2, conclusion: "cancelled" });
    const { deps, printed } = withWorld({
      runs: [green, stopped],
      jobs: {
        1: jobsOf(green),
        2: jobsOf(stopped, { browser: { conclusion: "cancelled" } }),
      },
    });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/concluded cancelled: .*\/runs\/2$/m);
  });

  it("refuses when the push run was re-run and its new attempt is still going", async () => {
    const pushed = runOf({
      head_sha: headSha,
      id: 1,
      created_at: "2026-11-08T09:00:00Z",
      run_started_at: "2026-11-08T12:00:00Z",
      run_attempt: 2,
      status: "in_progress",
      conclusion: null,
    });
    const dispatched = dispatchOf(headSha, older, { id: 2, created_at: "2026-11-08T10:00:00Z" });
    const { deps, printed } = withWorld({
      runs: [pushed, dispatched],
      jobs: { 1: [], 2: jobsOf(dispatched) },
    });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/is in_progress: .*\/runs\/1\./);
  });

  it("reads every page of dispatches, so a newer failure on page two still refuses", async () => {
    const failed = dispatchOf(headSha, older, {
      id: 999,
      conclusion: "failure",
      created_at: "2026-11-08T11:00:00Z",
    });
    const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const others = Array.from({ length: 150 }, (_, i) =>
      dispatchOf(older, older, { id: 2000 + i, created_at: "2026-11-08T12:00:00Z" }),
    );
    const { deps, printed, execs } = withWorld({
      runs: [green, ...others, failed],
      jobs: { 1: jobsOf(green), 999: jobsOf(failed) },
    });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/concluded failure: .*\/runs\/999$/m);
    expect(ghCalls(execs).some((c) => c.args.includes("page=2"))).toBe(true);
  });

  it("refuses rather than guess when more than ten pages of runs match", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => dispatchOf(older, older, { id: 3000 + i }));
    const { deps, printed } = withWorld({ runs: [...many, ...greenWorld(headSha).runs], jobs: {} });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/more than 1000 runs match.*no override/);
  });

  it("ignores a dispatch whose head is not on origin/main (a tag named main)", async () => {
    const tagHead = "e".repeat(40);
    const run = dispatchOf(headSha, tagHead);
    const { deps, printed } = withWorld(
      { runs: [run], jobs: { [run.id]: jobsOf(run) } },
      {
        exec: (c) =>
          c.cmd === "git" && c.args[0] === "merge-base" && c.args[2] === tagHead
            ? { code: 1, stdout: "" }
            : undefined,
      },
    );
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/no CI run of ci\.yml on main has tested/);
  });

  it("prints no state GitHub might invent, and never the run's own URL", async () => {
    const odd = runOf({
      head_sha: headSha,
      status: "completed",
      conclusion: "<script>",
    });
    const { deps, printed } = withWorld({ runs: [odd], jobs: { [odd.id]: jobsOf(odd) } });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(
      /concluded nothing known: https:\/\/github\.com\/jkowall\/TideGrid\/actions\/runs\/\d+$/m,
    );
    expect(printed.join("\n")).not.toContain("<script>");
    const weird = runOf({ head_sha: headSha, status: "exploded", conclusion: null });
    const w = withWorld({ runs: [weird], jobs: {} });
    expect(await main(approveArgv, w.deps)).toBe(3);
    expect(w.printed.join("\n")).toMatch(/in an unknown state/);
    expect(w.printed.join("\n")).not.toContain("exploded");
  });

  it("refuses, rather than skip, a newer run whose head this clone does not have (exit 128)", async () => {
    const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const unknownHead = "d".repeat(40);
    for (const newer of [
      dispatchOf(headSha, unknownHead, { id: 2, conclusion: "failure" }),
      dispatchOf(headSha, unknownHead, { id: 2, status: "in_progress", conclusion: null }),
      dispatchOf(headSha, unknownHead, { id: 2 }),
    ]) {
      const { deps, printed } = withWorld(
        { runs: [green, newer], jobs: { 1: jobsOf(green), 2: jobsOf(newer) } },
        {
          exec: (c) =>
            c.cmd === "git" && c.args[0] === "merge-base" && c.args[2] === unknownHead
              ? { code: 128, stdout: "" }
              : undefined,
        },
      );
      expect(await main(approveArgv, deps)).toBe(3);
      expect(printed.join("\n")).toMatch(
        /head dddddddddddd is not in this clone.*git fetch origin/,
      );
      expect(loadJournal(deps).approved).toEqual([]);
    }
  });

  it("refuses the guest kill-switch release when GitHub cannot be read: it deploys the tree", async () => {
    const { deps, execs, printed } = withWorld(
      { runs: [], jobs: {}, missing: true },
      { answers: ["tidegrid-guest"] },
    );
    frozen(deps);
    const argv = ["release", "guest", "--phase", "p4", "--kill-switch", "--live", "--go", "A4"];
    expect(await main(argv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/could not run gh/);
    expect(deploys(execs)).toEqual([]);
    expect(ciEntries(deps)).toMatchObject([{ result: "refused", gate: "A4" }]);
  });

  it("lets a newer non-green dispatch block even when its head looks off main (a stale origin/main)", async () => {
    const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const offHead = "f".repeat(40);
    for (const newer of [
      dispatchOf(headSha, offHead, { id: 2, conclusion: "failure" }),
      dispatchOf(headSha, offHead, { id: 2, status: "in_progress", conclusion: null }),
    ]) {
      const { deps, printed } = withWorld(
        {
          runs: [green, newer],
          jobs: { 1: jobsOf(green), 2: jobsOf(newer, { browser: { conclusion: "failure" } }) },
        },
        {
          exec: (c) =>
            c.cmd === "git" && c.args[0] === "merge-base" && c.args[2] === offHead
              ? { code: 1, stdout: "" }
              : undefined,
        },
      );
      expect(await main(approveArgv, deps)).toBe(3);
      expect(printed.join("\n")).toMatch(/\/runs\/2/);
    }
  });

  it("refuses when a newer cancelled run's job record cannot be read, instead of calling it unstarted", async () => {
    const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const stopped = dispatchOf(headSha, older, { id: 2, conclusion: "cancelled" });
    const broken = { ...jobsOf(stopped)[0], head_sha: undefined } as unknown as JobFixture;
    const { deps, printed } = withWorld({
      runs: [green, stopped],
      jobs: { 1: jobsOf(green), 2: [broken] },
    });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/include a record nov1 cannot read/);
  });

  it("refuses when a run row cannot be read, instead of dropping it", async () => {
    const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const odd = {
      ...dispatchOf(headSha, older, { id: 2, conclusion: "failure" }),
      run_attempt: undefined,
    } as unknown as RunFixture;
    const { deps, printed } = withWorld({ runs: [green, odd], jobs: { 1: jobsOf(green) } });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/includes a run nov1 cannot read/);
  });

  it("keeps a run's highest attempt when both queries return it", async () => {
    // The head query sees attempt 1 green; the dispatch query, a moment later, sees attempt 2 failing.
    const first = dispatchOf(headSha, headSha, { id: 5, created_at: "2026-11-08T10:00:00Z" });
    const second = {
      ...first,
      run_attempt: 2,
      conclusion: "failure",
      run_started_at: "2026-11-08T11:00:00Z",
    };
    const push = runOf({ head_sha: headSha, id: 4, created_at: "2026-11-08T10:30:00Z" });
    const gh = ghFrom({
      runs: [],
      jobs: { 4: jobsOf(push), 5: jobsOf(second, { checks: { conclusion: "failure" } }) },
    });
    const { deps, printed } = withWorld(
      { runs: [], jobs: {} },
      {
        exec: (c) => {
          if (c.cmd !== "gh") return undefined;
          const q = c.args.join(" ");
          if (q.includes("head_sha="))
            return {
              code: 0,
              stdout: JSON.stringify({ total_count: 2, workflow_runs: [first, push] }),
            };
          if (q.includes("event=workflow_dispatch"))
            return { code: 0, stdout: JSON.stringify({ total_count: 1, workflow_runs: [second] }) };
          return gh(c);
        },
      },
    );
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/concluded failure: .*\/runs\/5$/m);
  });

  it("reads dispatches with no date bound, so a commit dated in the future cannot hide a newer failure", async () => {
    const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const failed = dispatchOf(headSha, older, {
      id: 2,
      conclusion: "failure",
      created_at: "2026-11-08T10:00:00Z",
    });
    const { deps, printed, execs } = withWorld(
      { runs: [green, failed], jobs: { 1: jobsOf(green), 2: jobsOf(failed) } },
      {
        // Committed "on" 2026-11-10, after both runs.
        exec: (c) =>
          c.cmd === "git" && c.args[0] === "show" && c.args[1] === "-s"
            ? { code: 0, stdout: "1794268800\n" }
            : undefined,
      },
    );
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/concluded failure: .*\/runs\/2$/m);
    expect(ghCalls(execs).some((c) => c.args.some((a) => a.startsWith("created=")))).toBe(false);
  });

  it("refuses a retry cancelled before it started: the earlier attempt's result is hidden", async () => {
    const green = runOf({ head_sha: headSha, id: 1, created_at: "2026-11-08T09:00:00Z" });
    const retried = dispatchOf(headSha, older, {
      id: 2,
      conclusion: "cancelled",
      run_attempt: 2,
      created_at: "2026-11-08T10:00:00Z",
      run_started_at: "2026-11-08T11:00:00Z",
    });
    const { deps, printed } = withWorld({
      runs: [green, retried],
      jobs: { 1: jobsOf(green), 2: [] },
    });
    expect(await main(approveArgv, deps)).toBe(3);
    expect(printed.join("\n")).toMatch(/concluded cancelled: .*\/runs\/2$/m);
  });
});
