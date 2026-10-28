/**
 * nov1 release <api|console|guest> and --rollback (P3, P4, P7 to P11).
 *
 * Live steps re-check invariant 3 and the phase guard just before wrangler
 * runs, spawn the package's own `release` script on the owner's terminal, and
 * journal the version ids before and after. A release's postcondition is the
 * running build, not the deployment list: for the API, health `version` equal
 * to this tree's build id, because every secret change adds an untagged version.
 */
import { type Args, flag, has, onlyFlags } from "../args.ts";
import { banner, type Deps, Failure, out, type Plan, poll, printPlan, Refusal } from "../core.ts";
import { assertNoBuildLeak } from "../env.ts";
import { confirmYes, liveGate } from "../gate.ts";
import { assertReleasable, git } from "../git.ts";
import { lastDone, loadJournal, record, updateFlags, type Worker } from "../journal.ts";
import { loadConfigs, type Phase, parsePhase, phaseGuard } from "../phase.ts";
import {
  deployedVersions,
  onTerminal,
  parseWorker,
  workers,
  wranglerOnTerminal,
} from "../wrangler.ts";

export const releaseGates = ["A4", "A8", "A10", "A13", "A19"] as const;
export const apiBase = "https://api.tidegrid.us";
export const consoleOrigin = "https://console.tidegrid.us";
export const accessTeamDomain = "winter-feather-7169.cloudflareaccess.com";

const releaseCommand: Record<Worker, string> = {
  api: "wrangler deploy --var BUILD_ID:$(git describe --always --dirty)",
  console: "vite build && wrangler deploy",
  guest: "vite build && node scripts/check-precache.mjs && wrangler deploy",
};

export function releasePlan(worker: Worker, phase: Phase, rollback: boolean): Plan {
  const w = workers[worker];
  if (rollback) {
    return {
      command: `release ${worker} --rollback`,
      target: w.name,
      notes: [banner],
      steps: [
        {
          id: "R1",
          title: "Feature off first (invariant 9)",
          commands: [
            "nov1 secrets <phase> --delete <feature secret> (while the latest version is the deployed one)",
          ],
          expect: ["the feature answers off: checkout 503, email queued, Stripe off"],
          rollback: ["nov1 secrets <phase> --put <name> again"],
        },
        {
          id: "R2",
          title: `Roll ${w.name} back to the version recorded before its last release`,
          gate: "A4",
          commands: [
            `pnpm exec wrangler rollback <journal versionBefore> (cwd ${w.dir}, on the terminal)`,
          ],
          envNames: [],
          expect: [
            "wrangler asks for a message and a confirmation on the terminal; answer it yourself",
          ],
          verify:
            worker === "api"
              ? [`GET ${apiBase}/v1/health shows the earlier version`]
              : ["the earlier build serves"],
          rollback: [`nov1 release ${worker} (forward again)`],
          cannotRestore: [
            "bound resources: custom domains stay attached (cli.js:349363)",
            "the schema: migrations are forward-only",
            "whether a rollback changes crons or secrets is not documented (unverified)",
            "after a rollback, secret put fails with 10215: use wrangler versions secret put, then versions deploy (cli.js:299145)",
          ],
        },
      ],
    };
  }
  const verify: Record<Worker, string[]> = {
    api: [
      `GET ${apiBase}/v1/health: version = git describe, environment preview, database ok, migrations.latest = the tree's last file (memoized 10 s)`,
    ],
    console: [`GET ${consoleOrigin}/ unauthenticated redirects to ${accessTeamDomain}`],
    guest: [
      "each preview host answers 200 with a valid certificate (polled; issuance time is unverified)",
    ],
  };
  return {
    command: `release ${worker} --phase ${phase}`,
    target: w.name,
    notes: [
      banner,
      "Re-checked just before wrangler: HEAD = approved origin/main, clean migrations, not dirty, clean build env, phase guard.",
    ],
    steps: [
      {
        id: "1",
        title: `Record ${w.name}'s deployed version ids`,
        commands: [
          `pnpm exec wrangler deployments list --json (cwd ${w.dir}; ids parsed, the rest dropped)`,
        ],
        expect: ["one or more version ids"],
        rollback: ["not applicable (read-only)"],
      },
      {
        id: "2",
        title: `Release ${w.name}`,
        gate: "A4",
        commands: [`pnpm --filter ${w.pkg} run release  # ${releaseCommand[worker]}`],
        envNames: ["CLOUDFLARE_API_TOKEN (stripped)", "CLOUDFLARE_ACCOUNT_ID (passed if set)"],
        expect:
          worker === "guest"
            ? [
                "wrangler attaches the preview custom domains and creates DNS records and certificates (12:169)",
              ]
            : ["wrangler prints the new version id"],
        verify: verify[worker],
        rollback: [`nov1 release ${worker} --rollback --live --go A4 (feature off first)`],
        cannotRestore: ["custom domains attached by this release stay attached"],
      },
      {
        id: "3",
        title: "Record the new version ids as the rollback anchor",
        commands: [`pnpm exec wrangler deployments list --json (cwd ${w.dir})`],
        expect: ["version ids differ from step 1"],
        rollback: ["not applicable"],
      },
    ],
  };
}

async function healthVersion(deps: Deps): Promise<string | null> {
  try {
    const res = await deps.fetch(`${apiBase}/v1/health`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown; database?: unknown };
    return typeof body.version === "string" && body.database === "ok" ? body.version : null;
  } catch {
    return null;
  }
}

/** Whether the release took: the API reports this build; the console redirects to Access; the guest hosts serve. */
async function postcondition(deps: Deps, worker: Worker, buildId: string): Promise<boolean> {
  if (worker === "api") {
    return (
      (await poll(deps, async () => ((await healthVersion(deps)) === buildId ? true : null), {
        intervalMs: 5_000,
        timeoutMs: 120_000,
      })) === true
    );
  }
  if (worker === "console") {
    const res = await deps.fetch(`${consoleOrigin}/`, { redirect: "manual" });
    return (
      res.status >= 300 &&
      res.status < 400 &&
      (res.headers.get("location") ?? "").includes(accessTeamDomain)
    );
  }
  const hosts = loadConfigs(deps.repoRoot).guest.routes?.map((r) => r.pattern) ?? [];
  for (const host of hosts) {
    const ok = await poll(
      deps,
      async () => {
        try {
          return (await deps.fetch(`https://${host}/`, { redirect: "manual" })).status === 200
            ? true
            : null;
        } catch {
          return null;
        }
      },
      { intervalMs: 15_000, timeoutMs: 20 * 60_000 },
    );
    out(deps, `${host}: ${ok ? "200 with a valid certificate" : "not serving yet"}`);
    if (!ok) return false;
  }
  return true;
}

export async function release(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["live", "go", "phase", "rollback", "to", "kill-switch", "again"]);
  const worker = parseWorker(args.positional[0]);
  const phase = parsePhase(flag(args, "phase"));
  const rollback = has(args, "rollback");
  out(deps, banner);
  if (!has(args, "live")) {
    printPlan(deps, releasePlan(worker, phase, rollback));
    return 0;
  }
  const w = workers[worker];
  const killSwitch = has(args, "kill-switch");
  if (killSwitch && worker !== "guest")
    throw new Refusal("--kill-switch is for the guest release only");

  const gate = await liveGate(
    deps,
    { live: true, go: flag(args, "go") },
    {
      gates: releaseGates,
      confirm: [w.name],
      action: rollback ? `roll back ${w.name}` : `deploy ${w.name} from this tree`,
    },
  );

  if (rollback) return doRollback(deps, worker, phase, gate, flag(args, "to"));

  // Invariants 3, 7, and 11, again, just before acting.
  const state = await assertReleasable(deps);
  assertNoBuildLeak(deps, killSwitch ? ["GUEST_SW_KILL_SWITCH"] : []);
  const journal = loadJournal(deps);
  const guard = phaseGuard(phase, loadConfigs(deps.repoRoot), journal);
  for (const warning of guard.warnings) out(deps, `WARN ${warning}`);
  if (guard.refusals.length) throw new Refusal(`phase guard: ${guard.refusals.join("; ")}`);

  const buildId = await git(deps, ["describe", "--always", "--dirty"]);
  if (worker === "api" && !has(args, "again") && (await healthVersion(deps)) === buildId) {
    out(deps, `${w.name} already runs ${buildId}; nothing to do (--again to redeploy)`);
    record(deps, {
      phase,
      step: "release",
      gate,
      worker,
      sha: state.head,
      buildId,
      result: "skipped",
      note: "already released",
    });
    return 0;
  }
  const done = lastDone(journal, "release", worker);
  if (worker !== "api" && !has(args, "again") && done?.sha === state.head && !killSwitch) {
    out(
      deps,
      `${w.name} was released from ${state.head.slice(0, 12)} already; nothing to do (--again to redeploy)`,
    );
    return 0;
  }

  const before = await deployedVersions(deps, worker);
  record(deps, {
    phase,
    step: "release",
    gate,
    worker,
    sha: state.head,
    buildId,
    result: "started",
    versionBefore: before,
  });
  out(deps, banner);
  const code = await onTerminal(deps, "pnpm", ["--filter", w.pkg, "run", "release"], {
    ...(killSwitch ? { extraEnv: { GUEST_SW_KILL_SWITCH: "1" } } : {}),
  });
  const after = await deployedVersions(deps, worker).catch(() => [] as string[]);
  if (code !== 0) {
    record(deps, {
      phase,
      step: "release",
      gate,
      worker,
      sha: state.head,
      result: "failed",
      versionBefore: before,
      versionAfter: after,
      note: `exit ${code}`,
    });
    throw new Failure(`release ${worker} exited ${code}; nothing else ran`);
  }
  const took = await postcondition(deps, worker, buildId);
  record(deps, {
    phase,
    step: "release",
    gate,
    worker,
    sha: state.head,
    buildId,
    result: took ? "done" : "failed",
    versionBefore: before,
    versionAfter: after,
    ...(took ? {} : { note: "postcondition not met" }),
  });
  updateFlags(deps, (f) => {
    f.rolledBack = (f.rolledBack ?? []).filter((x) => x !== worker);
    if (phase === "p8" && worker === "guest" && took) f.cutoverDone = true;
    if (phase === "p11" && worker === "api")
      f.cronPaused = (loadConfigs(deps.repoRoot).api.triggers?.crons ?? []).length === 0;
  });
  if (!took) throw new Failure(`${w.name} deployed but its postcondition failed; see the journal`);
  out(deps, `${w.name} released: ${after.join(", ")}`);
  return 0;
}

async function doRollback(
  deps: Deps,
  worker: Worker,
  phase: Phase,
  gate: string,
  to?: string,
): Promise<number> {
  const w = workers[worker];
  const journal = loadJournal(deps);
  const anchor = to ?? lastDone(journal, "release", worker)?.versionBefore?.[0];
  if (!anchor || !/^[0-9a-f-]{36}$/.test(anchor)) {
    throw new Refusal(`no recorded version to roll ${w.name} back to; pass --to <version id>`);
  }
  out(
    deps,
    "Invariant 9: turn the feature off by secret first, while the latest version is still the deployed one.",
  );
  if (
    !(await confirmYes(
      deps,
      `Is the feature already off, or not needed, before rolling ${w.name} back?`,
    ))
  ) {
    throw new Refusal("feature-off first; nothing ran");
  }
  const before = await deployedVersions(deps, worker);
  const code = await wranglerOnTerminal(deps, worker, ["rollback", anchor]);
  const after = await deployedVersions(deps, worker).catch(() => [] as string[]);
  record(deps, {
    phase,
    step: "rollback",
    gate,
    worker,
    result: code === 0 ? "done" : "failed",
    versionBefore: before,
    versionAfter: after,
    note: "bound resources stay; secret changes now need wrangler versions secret put, then versions deploy",
  });
  if (code !== 0) throw new Failure(`wrangler rollback exited ${code}`);
  updateFlags(deps, (f) => {
    f.rolledBack = [...new Set([...(f.rolledBack ?? []), worker])];
  });
  out(
    deps,
    `${w.name} rolled back to ${anchor}. Custom domains and other bound resources are unchanged.`,
  );
  return 0;
}
