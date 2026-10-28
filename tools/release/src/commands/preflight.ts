/**
 * nov1 preflight. Offline is the default and the only mode before Nov 1 and in
 * CI: it reads files, git, and the owner's environment names, and runs
 * `pnpm release:dry`, which builds and dry-runs the three Workers with no
 * account. --network (Nov 1 only, gate A0) adds read-only calls: the wrangler
 * login type, each Worker's deployed version ids, and DNS lookups.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Args, flag, has, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, Refusal } from "../core.ts";
import { assertNoBuildLeak, buildLeakNames, childEnv, present, strippedNames } from "../env.ts";
import { liveGate } from "../gate.ts";
import { releaseState, releaseStateProblems } from "../git.ts";
import { loadJournal } from "../journal.ts";
import { loadConfigs, type Phase, parsePhase, phaseGuard } from "../phase.ts";
import { assertArgvSafe } from "../redact.ts";
import { deployedVersions } from "../wrangler.ts";

/** Environment variable names each phase reads. Presence only; values are never printed. */
export const phaseEnvNames: Partial<Record<Phase, string[]>> = {
  p2: ["NEON_DATABASE_URL", "NEON_API_KEY", "NEON_PROJECT_ID"],
  p6: ["NOV1_PRIVATE_DIR"],
  p8: ["NEON_DATABASE_URL"],
  p9: [
    "STRIPE_SECRET_KEY",
    "STRIPE_ACCT_DEMO_HARBOR",
    "STRIPE_ACCT_DEMO_REEF",
    "NEON_DATABASE_URL",
  ],
};

export const dnsNames = [
  "demo-harbor.book.tidegrid.us",
  "demo-reef.book.tidegrid.us",
  "demo.tidegrid.us",
  "customers.tidegrid.us",
  "saas-fallback.tidegrid.us",
];
/** A record on either of these before P4 is a hard stop: wrangler would override it. */
export const mustBeAbsent = dnsNames.slice(0, 2);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  warnOnly?: boolean;
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const all: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) all.push(...files(path));
    else all.push(path);
  }
  return all;
}

/** Release bundles must not mention localhost; source maps quote source and are skipped. */
export function localhostHits(root: string): string[] {
  return files(root).filter(
    (f) => !f.endsWith(".map") && readFileSync(f, "utf8").includes("localhost"),
  );
}

export function treeMigrations(repoRoot: string): string[] {
  return readdirSync(join(repoRoot, "packages/database/migrations"))
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

export async function preflight(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["offline", "network", "phase", "go", "live", "allow-branch", "skip-build"]);
  const phase = parsePhase(flag(args, "phase") ?? "p1");
  const network = has(args, "network");
  if (network && has(args, "offline")) throw new Refusal("--offline and --network contradict");
  const checks: Check[] = [];
  const add = (c: Check) => {
    checks.push(c);
    out(deps, `${c.ok ? "PASS" : c.warnOnly ? "WARN" : "FAIL"}  ${c.name}: ${c.detail}`);
  };

  if (network) {
    // Read-only calls, behind A0. Never before Nov 1, never in CI.
    await liveGate(
      deps,
      { live: true, go: flag(args, "go") },
      { gates: ["A0"], confirm: [], action: "read-only wrangler and DNS lookups", readOnly: true },
    );
  }

  const nvmrc = readFileSync(join(deps.repoRoot, ".nvmrc"), "utf8").trim();
  add({
    name: "node",
    ok: deps.nodeVersion === nvmrc,
    detail: `running ${deps.nodeVersion}, .nvmrc says ${nvmrc}`,
  });

  const leaks = buildLeakNames.filter((n) => present(deps.env, n));
  add({
    name: "build environment",
    ok: leaks.length === 0,
    detail: leaks.length ? `unset ${leaks.join(", ")}` : `none of ${buildLeakNames.join(", ")} set`,
  });
  for (const name of strippedNames) {
    if (present(deps.env, name))
      out(deps, `INFO  ${name} stripped: every wrangler child uses the OAuth login.`);
  }

  const journal = loadJournal(deps);
  const state = await releaseState(deps, journal);
  const problems = releaseStateProblems(state);
  add({
    name: "release state (invariant 3)",
    ok: problems.length === 0,
    warnOnly: has(args, "allow-branch"),
    detail: problems.length
      ? problems.join("; ")
      : `HEAD ${state.head.slice(0, 12)} is approved origin/main, clean`,
  });

  const guard = phaseGuard(phase, loadConfigs(deps.repoRoot), journal);
  add({
    name: `phase guard ${phase} (invariant 11)`,
    ok: guard.refusals.length === 0,
    detail: guard.refusals.length ? guard.refusals.join("; ") : "the Worker configs fit this phase",
  });
  for (const w of guard.warnings) out(deps, `WARN  phase guard: ${w}`);

  for (const name of phaseEnvNames[phase] ?? []) {
    add({
      name: `env ${name}`,
      ok: present(deps.env, name),
      warnOnly: true,
      detail: present(deps.env, name) ? "set (value not read)" : "not set in this shell",
    });
  }

  const migrations = treeMigrations(deps.repoRoot);
  out(
    deps,
    `INFO  migrations in the tree: ${migrations.length}, last ${migrations.at(-1)}. Expected pending on Neon main (P2.1 confirms): ${migrations
      .slice(2)
      .join(", ")}`,
  );

  if (!has(args, "skip-build")) {
    assertArgvSafe("pnpm", ["release:dry"]);
    // Build and dry-run the three Workers. No account is contacted.
    assertNoBuildLeak(deps);
    const { code } = await deps.exec("pnpm", ["release:dry"], {
      cwd: deps.repoRoot,
      env: childEnv(deps),
      stdio: "inherit",
    });
    add({ name: "pnpm release:dry", ok: code === 0, detail: `exit ${code}` });
    for (const app of ["apps/guest-site/dist", "apps/operator-site/dist"]) {
      const hits = localhostHits(join(deps.repoRoot, app));
      add({
        name: `${app} has no localhost`,
        ok: hits.length === 0,
        detail: hits.length
          ? hits.map((h) => h.slice(deps.repoRoot.length + 1)).join(", ")
          : "clean",
      });
    }
    const guestFiles = files(join(deps.repoRoot, "apps/guest-site/dist")).filter(
      (f) => f.endsWith(".js") && !f.endsWith(".map"),
    );
    const apiBase = guestFiles.some((f) =>
      readFileSync(f, "utf8").includes("https://api.tidegrid.us"),
    );
    add({
      name: "guest bundle calls https://api.tidegrid.us",
      ok: apiBase,
      detail: apiBase ? "found" : "missing",
    });
  }

  if (network) {
    // Only the login type is kept; the email and account ids in the output are discarded.
    const who = await deps.exec("pnpm", ["exec", "wrangler", "whoami"], {
      cwd: join(deps.repoRoot, "apps/api-worker"),
      env: childEnv(deps),
      stdio: "pipe",
    });
    const login = /OAuth Token/i.test(who.stdout)
      ? "OAuth"
      : /API Token/i.test(who.stdout)
        ? "API token"
        : "not logged in";
    add({ name: "wrangler login", ok: login === "OAuth", detail: login });
    for (const worker of ["api", "console", "guest"] as const) {
      const ids = await deployedVersions(deps, worker);
      add({ name: `deployed ${worker}`, ok: ids.length > 0, detail: ids.join(", ") || "none" });
    }
    for (const name of dnsNames) {
      assertArgvSafe("dig", ["+short", name]);
      const { stdout } = await deps.exec("dig", ["+short", name], {
        env: childEnv(deps),
        stdio: "pipe",
      });
      const records = stdout.trim().split("\n").filter(Boolean);
      const conflict = mustBeAbsent.includes(name) && records.length > 0;
      add({
        name: `dns ${name}`,
        ok: !conflict,
        warnOnly: !mustBeAbsent.includes(name),
        detail: records.length
          ? `${records.length} record(s)${conflict ? ": a conflict, hard stop for the guest release" : ""}`
          : "no record",
      });
    }
  }

  const failed = checks.filter((c) => !c.ok && !c.warnOnly);
  out(deps, failed.length ? `preflight FAILED: ${failed.length} check(s)` : "preflight passed");
  if (failed.length) throw new Failure("preflight failed");
  return 0;
}
