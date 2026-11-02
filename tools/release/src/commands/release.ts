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
import {
  type Entry,
  type Journal,
  lastDone,
  loadJournal,
  record,
  updateFlags,
  type Worker,
} from "../journal.ts";
import { isCutoverConfig, isSaasConfig, type Phase, parsePhase, phaseGuard } from "../phase.ts";
import {
  deployedVersions,
  onTerminal,
  parseWorker,
  workers,
  wranglerOnTerminal,
} from "../wrangler.ts";
import { treeMigrations } from "./preflight.ts";

/** The gate each phase's releases need. A rollback also accepts A4. */
export const releaseGateFor: Partial<Record<Phase, string>> = {
  p3: "A4",
  p4: "A4",
  p7: "A8",
  p8: "A10",
  p9: "A13",
  p10: "A17",
  p11: "A19",
};
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
      "Re-checked just before wrangler: HEAD = approved origin/main, clean migrations, not dirty, clean build env, phase guard; for the API, the live database at the tree's last migration (from /v1/health).",
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

/**
 * The live database's last applied migration, from the API's health (which
 * reads the database), or undefined when the health cannot say.
 */
async function databaseMigration(deps: Deps): Promise<string | null | undefined> {
  try {
    const res = await deps.fetch(`${apiBase}/v1/health`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      database?: unknown;
      migrations?: { latest?: unknown } | null;
    };
    // A failed database probe reports no migrations; that says nothing.
    if (body.database !== "ok") return undefined;
    const latest = body.migrations?.latest;
    if (latest === null) return null;
    return typeof latest === "string" ? latest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An API release waits for the database to reach the tree's last migration:
 * code released onto an older schema fails on the tables it expects (from
 * 0014, every staff email resend). A database ahead of the tree is allowed,
 * since migrations are forward-only and additive. When the health cannot
 * report (a failed database probe is memoized for 10 s), it reads again for
 * 15 s, then asks: a down API can still be redeployed, but never silently.
 */
async function assertSchemaReady(deps: Deps): Promise<void> {
  const tree = treeMigrations(deps.repoRoot).at(-1);
  if (!tree) return;
  const read = await poll(
    deps,
    async () => {
      const db = await databaseMigration(deps);
      return db === undefined ? null : { db };
    },
    { intervalMs: 5_000, timeoutMs: 15_000 },
  );
  if (read === null) {
    out(deps, `WARN could not read the database's migrations from ${apiBase}/v1/health`);
    if (
      !(await confirmYes(
        deps,
        `Is the database already at ${tree} (nov1 db status), so the API may be released without this check?`,
      ))
    ) {
      throw new Refusal("the database's migrations could not be read; nothing ran");
    }
    return;
  }
  const { db } = read;
  if (db === null || db < tree) {
    throw new Refusal(
      `the database is at ${db ?? "no migration"}, behind the tree's ${tree}. Apply the migrations first (nov1 db), then release the API; the health memoizes for 10 s`,
    );
  }
  if (db > tree) out(deps, `WARN the database is at ${db}, ahead of the tree's ${tree}`);
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
  const hosts = deps.configs().guest.routes?.map((r) => r.pattern) ?? [];
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

function gatesFor(phase: Phase, rollback: boolean): string[] {
  const gate = releaseGateFor[phase];
  if (!gate) {
    throw new Refusal(
      `no release runs in ${phase}; releases run in ${Object.keys(releaseGateFor).join(", ")}`,
    );
  }
  return rollback && gate !== "A4" ? [gate, "A4"] : [gate];
}

/**
 * The rollback anchor: the version that was live before the most recent
 * release of this Worker, whatever that release's result. A release whose
 * deploy went out but whose postcondition failed is the one to undo, so it is
 * never skipped (review F3).
 */
export function rollbackAnchor(journal: Journal, worker: Worker): Entry | undefined {
  return [...journal.entries].reverse().find(
    (e) =>
      e.step === "release" &&
      e.worker === worker &&
      (e.versionBefore?.length ?? 0) > 0 &&
      // A release that failed before upload moved nothing; it is not the one to undo.
      !(e.versionAfter && sameIds(e.versionAfter, e.versionBefore ?? [])) &&
      // A started entry without its outcome is superseded by that outcome.
      e.result !== "started",
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

export async function release(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["live", "go", "phase", "rollback", "to", "kill-switch", "again", "verify"]);
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

  const verify = has(args, "verify");
  if (verify && rollback) throw new Refusal("--verify and --rollback contradict");

  // The anchor is shown, with the release it undoes, before the owner types it back.
  let anchor: string | undefined;
  if (rollback) {
    const entry = rollbackAnchor(loadJournal(deps), worker);
    anchor = flag(args, "to") ?? entry?.versionBefore?.[0];
    if (!anchor || !/^[0-9a-f-]{36}$/.test(anchor)) {
      throw new Refusal(`no recorded version to roll ${w.name} back to; pass --to <version id>`);
    }
    out(
      deps,
      entry && !flag(args, "to")
        ? `rollback anchor ${anchor}: the version live before the ${entry.phase} release at ${entry.at} (${entry.result}${entry.sha ? `, ${entry.sha.slice(0, 12)}` : ""})`
        : `rollback anchor ${anchor} (from --to)`,
    );
  }

  const gate = await liveGate(
    deps,
    { live: true, go: flag(args, "go") },
    {
      gates: gatesFor(phase, rollback),
      confirm: verify ? [] : rollback ? [w.name, (anchor as string).slice(0, 8)] : [w.name],
      action: verify
        ? `re-check ${w.name}'s postcondition (read-only)`
        : rollback
          ? `roll back ${w.name} to ${anchor}`
          : `deploy ${w.name} from this tree`,
      readOnly: verify,
    },
  );

  if (rollback) return doRollback(deps, worker, phase, gate, anchor as string);
  if (verify) {
    const buildId = await git(deps, ["describe", "--always", "--dirty"]);
    const ok = await postcondition(deps, worker, buildId);
    record(deps, {
      phase,
      step: "release-verify",
      gate,
      worker,
      buildId,
      result: ok ? "done" : "failed",
    });
    if (!ok) throw new Failure(`${w.name}'s postcondition is still not met`);
    out(deps, `${w.name}: postcondition met`);
    return 0;
  }

  // Invariants 3, 7, and 11, again, just before acting.
  const state = await assertReleasable(deps);
  assertNoBuildLeak(deps, killSwitch ? ["GUEST_SW_KILL_SWITCH"] : []);
  const journal = loadJournal(deps);
  const guard = phaseGuard(phase, deps.configs(), journal);
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
  if (worker === "api") await assertSchemaReady(deps);
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
    ...(took ? {} : { note: "deployed; postcondition not met (re-check with --verify)" }),
  });
  // The flags follow what was deployed (wrangler exited 0), not the poll: a
  // slow certificate must not leave later phases refused (review F3).
  const deployed = deps.configs();
  updateFlags(deps, (f) => {
    f.rolledBack = (f.rolledBack ?? []).filter((x) => x !== worker);
    if (phase === "p8" && worker === "guest") f.cutoverDone = isCutoverConfig(deployed);
    if (phase === "p10" && worker === "api") f.saasEnabled = isSaasConfig(deployed);
    if (phase === "p11" && worker === "api")
      f.cronPaused = (deployed.api.triggers?.crons ?? []).length === 0;
  });
  if (!took) {
    throw new Failure(
      `${w.name} deployed but its postcondition failed. When the hosts serve, run: nov1 release ${worker} --phase ${phase} --verify --live --go ${gate}`,
    );
  }
  out(deps, `${w.name} released: ${after.join(", ")}`);
  return 0;
}

async function doRollback(
  deps: Deps,
  worker: Worker,
  phase: Phase,
  gate: string,
  anchor: string,
): Promise<number> {
  const w = workers[worker];
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
  if (before.includes(anchor)) {
    throw new Refusal(
      `${anchor} is already live on ${w.name}; nothing to roll back to. Pass --to <an earlier version id>`,
    );
  }
  const code = await wranglerOnTerminal(deps, worker, ["rollback", anchor]);
  const readAfter = () => deployedVersions(deps, worker).catch(() => null);
  let after = await readAfter();
  // wrangler 4.135.0 exits 0 when the owner declines its changed-secrets
  // prompt (10220; cli.js:349407-349415), so exit 0 alone proves nothing:
  // the rollback is done only when exactly the anchor is live afterwards.
  const anchorAlone = (ids: string[] | null) => ids !== null && sameIds(ids, [anchor]);
  if (code === 0 && !anchorAlone(after)) {
    // A precaution in case the listing trails a finished rollback (unverified):
    // read it once more.
    out(deps, `The listing does not show ${anchor} alone yet; reading it again in 5 s.`);
    await deps.sleep(5000);
    after = await readAfter();
  }
  const live = anchorAlone(after);
  const note =
    "bound resources stay; secret changes now need wrangler versions secret put, then versions deploy";
  record(deps, {
    phase,
    step: "rollback",
    gate,
    worker,
    result: code === 0 && live ? "done" : "failed",
    versionBefore: before,
    versionAfter: after ?? [],
    note:
      code === 0 && after === null
        ? `deployments listing unreadable after the rollback; ${note}`
        : note,
  });
  if (code !== 0) throw new Failure(`wrangler rollback exited ${code}`);
  if (after === null) {
    // The rollback may have run: keep refusing plain secret edits until the
    // owner reads the listing.
    updateFlags(deps, (f) => {
      f.rolledBack = [...new Set([...(f.rolledBack ?? []), worker])];
    });
    throw new Failure(
      `wrangler rollback exited 0, but the deployments could not be read. Check with: pnpm exec wrangler deployments list (in ${w.dir}) before any secret change`,
    );
  }
  if (!live) {
    throw new Failure(
      `wrangler rollback exited 0, but ${anchor} is not live alone (live: ${after.join(", ") || "none"}). A declined prompt aborts the rollback. Check with: pnpm exec wrangler deployments list (in ${w.dir}) before retrying`,
    );
  }
  updateFlags(deps, (f) => {
    f.rolledBack = [...new Set([...(f.rolledBack ?? []), worker])];
  });
  out(
    deps,
    `${w.name} rolled back to ${anchor}. Custom domains and other bound resources are unchanged.`,
  );
  return 0;
}
