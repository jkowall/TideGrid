/**
 * Release one Worker from GitHub (release.yml), and roll one back.
 *
 * The flow, for each Worker:
 *   1. Read what is live: the current deployment's versions (must be one
 *      version at 100%), and the Worker's custom domains, cron schedules, and
 *      workers.dev settings from the Cloudflare API.
 *   2. Refuse when those settings differ from the Worker's wrangler.jsonc.
 *      `versions upload` and `versions deploy` never change them, so a change
 *      there would silently not apply. Such a change still goes through nov1
 *      on the owner's terminal.
 *   3. Build (console and guest), then `wrangler versions upload`, tagged
 *      with the commit. Nothing serves the new version yet.
 *   4. Move traffic: all at once, or 10% first with checks against the new
 *      version, a soak, then 100%.
 *   5. Check the result (the API's health reports this build; the console
 *      redirects to Access; each guest host serves). On any failure after
 *      traffic moved, put the earlier version back at 100% and fail the job.
 *   6. Write one release ledger line (JSON) and a step summary.
 *
 * Wrangler is never asked anything: `versions deploy` gets every version and
 * percentage plus `--yes`, so no prompt has a default to fall back on, and
 * neither command publishes custom domains or DNS records (wrangler 4.152.0
 * cli.js:182059-182066: triggers apply only through `wrangler triggers
 * deploy` or `wrangler deploy`).
 */
import { join } from "node:path";
import { parseJsonc } from "../phase.ts";
import {
  buildEnv,
  buildLeakNames,
  childEnv,
  type GhDeps,
  GhFailure,
  GhRefusal,
  say,
} from "./deps.ts";

export type GhWorker = "api" | "console" | "guest";
export const ghWorkers: readonly GhWorker[] = ["api", "console", "guest"];

export const workerInfo: Record<GhWorker, { name: string; pkg: string; dir: string }> = {
  api: { name: "tidegrid-api", pkg: "@tidegrid/api-worker", dir: "apps/api-worker" },
  console: { name: "tidegrid-console", pkg: "@tidegrid/operator-site", dir: "apps/operator-site" },
  guest: { name: "tidegrid-guest", pkg: "@tidegrid/guest-site", dir: "apps/guest-site" },
};

export const apiBase = "https://api.tidegrid.us";
export const consoleOrigin = "https://console.tidegrid.us";
export const accessTeamDomain = "winter-feather-7169.cloudflareaccess.com";
const cfApi = "https://api.cloudflare.com/client/v4";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Traffic = "all-at-once" | "ten-percent-first";

export interface VersionShare {
  id: string;
  percentage: number;
}

export interface LedgerEntry {
  kind: "release" | "rollback";
  worker: string;
  sha?: string;
  build_id?: string;
  traffic?: Traffic;
  before: VersionShare[];
  after: VersionShare[];
  outcome: "released" | "rolled_back" | "failed_before_traffic" | "rollback_failed";
  note?: string;
  run_url: string;
  at: string;
}

/* ------------------------------------------------------------------ */
/* What the tree says                                                  */
/* ------------------------------------------------------------------ */

export interface TriggerSettings {
  domains: string[];
  crons: string[];
  workersDev: boolean | undefined;
  previewUrls: boolean | undefined;
}

interface RawConfig {
  name?: string;
  routes?: ({ pattern?: string; custom_domain?: boolean } | string)[];
  triggers?: { crons?: string[] };
  workers_dev?: boolean;
  preview_urls?: boolean;
}

export function readConfig(deps: GhDeps, worker: GhWorker): RawConfig {
  const path = join(deps.repoRoot, workerInfo[worker].dir, "wrangler.jsonc");
  return parseJsonc(deps.readFile(path)) as RawConfig;
}

/**
 * The top-level (deployed) settings this path cannot change. A plain route
 * (not a custom domain) is refused outright: no Worker uses one, and the
 * check below reads custom domains only.
 */
export function wantedTriggers(config: RawConfig, worker: GhWorker): TriggerSettings {
  if (config.name !== workerInfo[worker].name) {
    throw new GhRefusal(
      `${worker}'s wrangler.jsonc names ${config.name ?? "nothing"}, not ${workerInfo[worker].name}`,
    );
  }
  const domains: string[] = [];
  for (const r of config.routes ?? []) {
    if (typeof r === "string" || r.custom_domain !== true || !r.pattern) {
      throw new GhRefusal(
        `${worker} has a route that is not a custom domain; release it with nov1 on the owner's terminal`,
      );
    }
    domains.push(r.pattern.toLowerCase());
  }
  return {
    domains: [...new Set(domains)].sort(),
    crons: [...new Set(config.triggers?.crons ?? [])].sort(),
    workersDev: config.workers_dev,
    previewUrls: config.preview_urls,
  };
}

/** Each difference, in words. Empty when the live Worker matches the tree. */
export function triggerDiff(want: TriggerSettings, live: TriggerSettings): string[] {
  const diffs: string[] = [];
  const list = (a: string[]) => (a.length ? a.join(", ") : "none");
  if (list(want.domains) !== list(live.domains)) {
    diffs.push(`custom domains: tree ${list(want.domains)}, live ${list(live.domains)}`);
  }
  if (list(want.crons) !== list(live.crons)) {
    diffs.push(`cron schedules: tree ${list(want.crons)}, live ${list(live.crons)}`);
  }
  if (want.workersDev !== undefined && want.workersDev !== live.workersDev) {
    diffs.push(`workers.dev: tree ${want.workersDev}, live ${live.workersDev}`);
  }
  if (want.previewUrls !== undefined && want.previewUrls !== live.previewUrls) {
    diffs.push(`preview URLs: tree ${want.previewUrls}, live ${live.previewUrls}`);
  }
  return diffs;
}

/* ------------------------------------------------------------------ */
/* What is live                                                        */
/* ------------------------------------------------------------------ */

async function cf(deps: GhDeps, path: string): Promise<unknown> {
  const token = deps.env.CLOUDFLARE_API_TOKEN;
  let res: Response;
  try {
    res = await deps.fetch(`${cfApi}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new GhRefusal(`could not reach the Cloudflare API (${path.split("?")[0]})`);
  }
  let body: { success?: unknown; result?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new GhRefusal(`the Cloudflare API did not answer JSON (${res.status})`);
  }
  if (!res.ok || body.success !== true) {
    throw new GhRefusal(
      `the Cloudflare API refused a read (${res.status}); check the token's permissions in the runbook`,
    );
  }
  return body.result;
}

export async function liveTriggers(deps: GhDeps, worker: GhWorker): Promise<TriggerSettings> {
  const account = deps.env.CLOUDFLARE_ACCOUNT_ID;
  const name = workerInfo[worker].name;
  const [domains, schedules, subdomain] = await Promise.all([
    cf(deps, `/accounts/${account}/workers/domains?service=${name}`),
    cf(deps, `/accounts/${account}/workers/scripts/${name}/schedules`),
    cf(deps, `/accounts/${account}/workers/scripts/${name}/subdomain`),
  ]);
  if (!Array.isArray(domains)) throw new GhRefusal("unexpected custom domain listing");
  const hostnames = domains
    .map((d) => (d as { hostname?: unknown; service?: unknown }).hostname)
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.toLowerCase());
  const crons = ((schedules as { schedules?: { cron?: unknown }[] } | null)?.schedules ?? [])
    .map((s) => s.cron)
    .filter((c): c is string => typeof c === "string");
  const sub = (subdomain ?? {}) as { enabled?: unknown; previews_enabled?: unknown };
  return {
    domains: [...new Set(hostnames)].sort(),
    crons: [...new Set(crons)].sort(),
    workersDev: typeof sub.enabled === "boolean" ? sub.enabled : undefined,
    previewUrls: typeof sub.previews_enabled === "boolean" ? sub.previews_enabled : undefined,
  };
}

async function wrangler(
  deps: GhDeps,
  worker: GhWorker,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const { code, stdout } = await deps.exec("pnpm", ["exec", "wrangler", ...args], {
    cwd: join(deps.repoRoot, workerInfo[worker].dir),
    env: childEnv(deps, extraEnv),
  });
  if (code !== 0) {
    throw new GhFailure(
      `wrangler ${args.slice(0, 2).join(" ")} failed for ${worker} (exit ${code})`,
    );
  }
  return stdout;
}

/** The current deployment's versions, ids and percentages only. */
export function parseDeploymentStatus(stdout: string): VersionShare[] {
  const start = stdout.search(/[[{]/);
  let body: unknown;
  try {
    body = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    throw new GhFailure("wrangler deployments status did not print JSON");
  }
  const versions = (body as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) throw new GhFailure("wrangler deployments status has no versions");
  return versions.map((v) => {
    const id = (v as { version_id?: unknown }).version_id;
    const percentage = (v as { percentage?: unknown }).percentage;
    if (typeof id !== "string" || !uuid.test(id) || typeof percentage !== "number") {
      throw new GhFailure("wrangler deployments status has an unreadable version");
    }
    return { id, percentage };
  });
}

export async function currentDeployment(deps: GhDeps, worker: GhWorker): Promise<VersionShare[]> {
  return parseDeploymentStatus(await wrangler(deps, worker, ["deployments", "status", "--json"]));
}

/**
 * The rollback target for `previous`: the version that served alone at 100%
 * just before the current version first went live. Read from
 * `deployments list --json` (oldest first, cli.js:361001); ids and
 * percentages only, the author emails are dropped.
 *
 * Walking back from where the current version first appeared skips its own
 * 10% step and, after an automatic rollback, the failed release, so
 * `previous` never brings back a split or the version that just failed.
 */
export function previousDeployment(stdout: string, current: VersionShare[]): VersionShare[] | null {
  const start = stdout.search(/[[{]/);
  let list: unknown;
  try {
    list = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    throw new GhFailure("wrangler deployments list did not print JSON");
  }
  if (!Array.isArray(list)) throw new GhFailure("wrangler deployments list is not a list");
  const deployments = list.map((d) =>
    ((d as { versions?: { version_id?: unknown; percentage?: unknown }[] }).versions ?? []).map(
      (v) => ({ id: String(v.version_id ?? ""), percentage: Number(v.percentage) }),
    ),
  );
  const currentId = single(current);
  if (!currentId) return null;
  const first = deployments.findIndex((d) => d.some((s) => s.id === currentId));
  for (let i = (first < 0 ? deployments.length : first) - 1; i >= 0; i--) {
    const id = single(deployments[i] as VersionShare[]);
    if (id && uuid.test(id) && id !== currentId) return [{ id, percentage: 100 }];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Checks against the running Worker                                   */
/* ------------------------------------------------------------------ */

async function poll<T>(
  deps: GhDeps,
  fn: () => Promise<T | null>,
  { intervalMs, timeoutMs }: { intervalMs: number; timeoutMs: number },
): Promise<T | null> {
  const end = deps.now().getTime() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (deps.now().getTime() >= end) return null;
    await deps.sleep(intervalMs);
  }
}

async function getHealth(
  deps: GhDeps,
  headers: Record<string, string> = {},
): Promise<{
  version?: unknown;
  database?: unknown;
  migrations?: { latest?: unknown } | null;
} | null> {
  try {
    const res = await deps.fetch(`${apiBase}/v1/health`, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      version?: unknown;
      database?: unknown;
      migrations?: { latest?: unknown } | null;
    };
  } catch {
    return null;
  }
}

/** The header that sends one request to a named version in a split deployment. */
export function versionOverride(worker: GhWorker, versionId: string): Record<string, string> {
  return { "Cloudflare-Workers-Version-Overrides": `${workerInfo[worker].name}="${versionId}"` };
}

/**
 * Whether the Worker answers as expected. With `versionId`, each request
 * names that version (used while only 10% of traffic is on it).
 */
export async function workerHealthy(
  deps: GhDeps,
  worker: GhWorker,
  buildId: string,
  opts: { versionId?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const headers = opts.versionId ? versionOverride(worker, opts.versionId) : {};
  const timeoutMs = opts.timeoutMs ?? 120_000;
  if (worker === "api") {
    const ok = await poll(
      deps,
      async () => {
        const h = await getHealth(deps, headers);
        return h && h.version === buildId && h.database === "ok" ? true : null;
      },
      { intervalMs: 5_000, timeoutMs },
    );
    return ok === true;
  }
  if (worker === "console") {
    const ok = await poll(
      deps,
      async () => {
        try {
          const res = await deps.fetch(`${consoleOrigin}/`, {
            redirect: "manual",
            headers,
            signal: AbortSignal.timeout(10_000),
          });
          const loc = res.headers.get("location") ?? "";
          return res.status >= 300 && res.status < 400 && loc.includes(accessTeamDomain)
            ? true
            : null;
        } catch {
          return null;
        }
      },
      { intervalMs: 5_000, timeoutMs },
    );
    return ok === true;
  }
  const hosts = wantedTriggers(readConfig(deps, "guest"), "guest").domains;
  for (const host of hosts) {
    const ok = await poll(
      deps,
      async () => {
        try {
          const res = await deps.fetch(`https://${host}/`, {
            redirect: "manual",
            headers,
            signal: AbortSignal.timeout(10_000),
          });
          return res.status === 200 ? true : null;
        } catch {
          return null;
        }
      },
      { intervalMs: 5_000, timeoutMs },
    );
    say(deps, `  ${host}: ${ok ? "200" : "not serving"}`);
    if (ok !== true) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Schema gate (no secrets)                                            */
/* ------------------------------------------------------------------ */

export function treeLastMigration(files: readonly string[]): string | undefined {
  return files
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .at(-1);
}

/**
 * The live database must already hold the tree's last migration before the
 * API is released: code on an older schema fails on tables it expects. Read
 * from the public health, which reads the database. Migrations go through
 * neon-migrate.yml, never this workflow.
 */
export async function schemaReady(deps: GhDeps, treeLast: string | undefined): Promise<void> {
  if (!treeLast) throw new GhRefusal("the tree has no migrations");
  const h = await poll(
    deps,
    async () => {
      const got = await getHealth(deps);
      return got && got.database === "ok" ? got : null;
    },
    { intervalMs: 5_000, timeoutMs: 30_000 },
  );
  if (!h) {
    throw new GhRefusal(
      `${apiBase}/v1/health did not report a working database; the API release waits until it does`,
    );
  }
  const live = h.migrations?.latest;
  if (typeof live !== "string" || live < treeLast) {
    throw new GhRefusal(
      `the live database is at ${typeof live === "string" ? live : "no migration"}, behind this commit's ${treeLast}. Run neon-migrate for this commit first, then release`,
    );
  }
  say(deps, `live database at ${live}; this commit's last migration is ${treeLast}`);
}

/* ------------------------------------------------------------------ */
/* Release                                                             */
/* ------------------------------------------------------------------ */

export interface ReleaseOptions {
  worker: GhWorker;
  sha: string;
  buildId: string;
  traffic: Traffic;
  /** How long 10% runs before the move to 100%, in seconds. */
  soakSeconds: number;
  ledgerPath: string;
}

function runUrl(deps: GhDeps): string {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = deps.env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : "local";
}

export function assertReleaseEnv(deps: GhDeps): void {
  if (deps.env.GITHUB_ACTIONS !== "true") {
    throw new GhRefusal("this runs only inside the release workflow; on a laptop use nov1");
  }
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!deps.env[name]) {
      throw new GhRefusal(`${name} is not set on the production environment (see the runbook)`);
    }
  }
  const leaks = buildLeakNames.filter((n) => deps.env[n]);
  if (leaks.length)
    throw new GhRefusal(`build settings would leak into the bundle: ${leaks.join(", ")}`);
}

function writeLedger(deps: GhDeps, path: string, entry: LedgerEntry): void {
  deps.appendFile(path, `${JSON.stringify(entry)}\n`);
  const summary = deps.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const fmt = (v: VersionShare[]) =>
      v.length ? v.map((s) => `\`${s.id}\` ${s.percentage}%`).join(", ") : "none";
    const lines = [
      `### ${entry.kind === "release" ? "Release" : "Rollback"} ${entry.worker}: ${entry.outcome.replace(/_/g, " ")}`,
      entry.sha
        ? `- Commit \`${entry.sha}\`, build \`${entry.build_id}\`, traffic ${entry.traffic}`
        : "",
      `- Before: ${fmt(entry.before)}`,
      `- After: ${fmt(entry.after)}`,
      entry.note ? `- ${entry.note}` : "",
    ].filter(Boolean);
    deps.appendFile(summary, `${lines.join("\n")}\n\n`);
  }
}

function single(shares: VersionShare[]): string | null {
  return shares.length === 1 && shares[0]?.percentage === 100 ? shares[0].id : null;
}

async function deploy(deps: GhDeps, worker: GhWorker, specs: string[], message: string) {
  await wrangler(deps, worker, ["versions", "deploy", ...specs, "--message", message, "--yes"]);
}

/** Put `shares` back exactly and confirm. Returns whether the deployment now matches. */
async function restore(deps: GhDeps, worker: GhWorker, shares: VersionShare[], msg: string) {
  try {
    await deploy(
      deps,
      worker,
      shares.map((s) => `${s.id}@${s.percentage}%`),
      msg,
    );
  } catch (e) {
    // wrangler can move traffic and still exit non-zero (its settings sync
    // runs after the deployment, cli.js:360766), so the deployment decides.
    say(deps, `rollback command error: ${(e as Error).message}; reading what is live`);
  }
  try {
    return sameShares(await currentDeployment(deps, worker), shares);
  } catch (e) {
    say(deps, `could not read the deployment after the rollback: ${(e as Error).message}`);
    return false;
  }
}

export function sameShares(a: VersionShare[], b: VersionShare[]): boolean {
  const key = (v: VersionShare[]) =>
    v
      .map((s) => `${s.id}@${s.percentage}`)
      .sort()
      .join(",");
  return key(a) === key(b);
}

export function parseUploadOutput(text: string): string {
  const ids = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as { type?: unknown; version_id?: unknown };
      } catch {
        return {};
      }
    })
    .filter((e) => e.type === "version-upload")
    .map((e) => e.version_id);
  const id = ids.at(-1);
  if (typeof id !== "string" || !uuid.test(id)) {
    throw new GhFailure("wrangler versions upload did not report a version id");
  }
  return id;
}

async function build(deps: GhDeps, worker: GhWorker): Promise<void> {
  // The same build each package's `release` script runs before wrangler.
  const steps: Record<GhWorker, [string, string[]][]> = {
    api: [],
    console: [["pnpm", ["exec", "vite", "build"]]],
    guest: [
      ["pnpm", ["exec", "vite", "build"]],
      ["node", ["scripts/check-precache.mjs"]],
    ],
  };
  for (const [cmd, args] of steps[worker]) {
    const { code } = await deps.exec(cmd, args, {
      cwd: join(deps.repoRoot, workerInfo[worker].dir),
      // The build never sees the Cloudflare token: only wrangler gets it.
      env: buildEnv(deps),
    });
    if (code !== 0) throw new GhFailure(`${worker} build failed: ${cmd} ${args.join(" ")}`);
  }
}

async function buildAndUpload(
  deps: GhDeps,
  o: ReleaseOptions,
  oldId: string,
  url: string,
): Promise<string> {
  const { worker } = o;
  await build(deps, worker);
  const outFile = deps.tempPath(`wrangler-${worker}.ndjson`);
  const message =
    `release ${o.sha} ${url === "local" ? "" : `run ${deps.env.GITHUB_RUN_ID}`}`.trim();
  await wrangler(
    deps,
    worker,
    [
      "versions",
      "upload",
      // Without --strict, wrangler in CI silently overrides changes made in
      // the dashboard since the last upload (getDeployConfirmFunction,
      // cli.js:180514). With it, the upload stops and nothing moves.
      "--strict",
      "--tag",
      o.sha.slice(0, 12),
      "--message",
      message,
      ...(worker === "api" ? ["--var", `BUILD_ID:${o.buildId}`] : []),
    ],
    { WRANGLER_OUTPUT_FILE_PATH: outFile },
  );
  const newId = parseUploadOutput(deps.readFile(outFile));
  if (newId === oldId) throw new GhFailure("the upload returned the live version id");
  say(deps, `uploaded ${newId} (no traffic yet)`);
  return newId;
}

export async function releaseWorker(deps: GhDeps, o: ReleaseOptions): Promise<void> {
  assertReleaseEnv(deps);
  const { worker } = o;
  if (!/^[0-9a-f]{40}$/.test(o.sha)) throw new GhRefusal("give the full 40-character SHA");
  if (!/^[0-9a-f]{7,40}$/.test(o.buildId)) throw new GhRefusal("the build id must be a short SHA");
  const name = workerInfo[worker].name;
  const url = runUrl(deps);
  const at = () => deps.now().toISOString();
  say(deps, `== ${name} at ${o.sha.slice(0, 12)} (${o.traffic})`);

  // 1 and 2: what is live, and whether this path can release it.
  const before = await currentDeployment(deps, worker);
  const oldId = single(before);
  if (!oldId) {
    throw new GhRefusal(
      `${name} is not on one version at 100% (${before.map((s) => `${s.id}@${s.percentage}%`).join(", ")}); finish or undo that split first`,
    );
  }
  const diffs = triggerDiff(
    wantedTriggers(readConfig(deps, worker), worker),
    await liveTriggers(deps, worker),
  );
  if (diffs.length) {
    throw new GhRefusal(
      `${name}'s domains or schedules in this commit differ from what is live, and this workflow cannot change them: ${diffs.join("; ")}. Release this change with nov1 on the owner's terminal`,
    );
  }
  say(deps, `live: ${oldId} at 100%; custom domains and schedules match the tree`);

  // 3: build and upload. Nothing serves the new version yet.
  let newId: string;
  try {
    newId = await buildAndUpload(deps, o, oldId, url);
  } catch (e) {
    writeLedger(deps, o.ledgerPath, {
      kind: "release",
      worker: name,
      sha: o.sha,
      build_id: o.buildId,
      traffic: o.traffic,
      before,
      after: before,
      outcome: "failed_before_traffic",
      note: `${(e as Error).message}; no traffic moved`,
      run_url: url,
      at: at(),
    });
    throw e;
  }

  const fail = async (why: string): Promise<never> => {
    say(deps, `FAILED: ${why}. Putting ${oldId} back at 100%`);
    const back = await restore(
      deps,
      worker,
      before,
      `rollback after failed release ${o.sha.slice(0, 12)}`,
    );
    const after = await currentDeployment(deps, worker).catch(() => [] as VersionShare[]);
    writeLedger(deps, o.ledgerPath, {
      kind: "release",
      worker: name,
      sha: o.sha,
      build_id: o.buildId,
      traffic: o.traffic,
      before,
      after,
      outcome: back ? "rolled_back" : "rollback_failed",
      note: back
        ? `${why}; the earlier version serves again`
        : `${why}; ROLLBACK DID NOT TAKE, see the runbook`,
      run_url: url,
      at: at(),
    });
    throw new GhFailure(back ? `${why}; rolled back` : `${why}; the rollback did not take`);
  };

  // 4: traffic.
  if (o.traffic === "ten-percent-first") {
    try {
      await deploy(deps, worker, [`${newId}@10%`, `${oldId}@90%`], `10% ${o.sha.slice(0, 12)}`);
    } catch (e) {
      return fail(`the 10% step failed: ${(e as Error).message}`);
    }
    if (!(await workerHealthy(deps, worker, o.buildId, { versionId: newId }))) {
      return fail("the new version failed its checks at 10%");
    }
    say(deps, `10% healthy; watching for ${o.soakSeconds} s`);
    const end = deps.now().getTime() + o.soakSeconds * 1000;
    while (deps.now().getTime() < end) {
      await deps.sleep(Math.min(30_000, Math.max(0, end - deps.now().getTime())));
      if (
        !(await workerHealthy(deps, worker, o.buildId, { versionId: newId, timeoutMs: 20_000 }))
      ) {
        return fail("the new version failed a check during the 10% soak");
      }
    }
  }
  try {
    await deploy(deps, worker, [`${newId}@100%`], `release ${o.sha.slice(0, 12)}`);
  } catch (e) {
    return fail(`moving to 100% failed: ${(e as Error).message}`);
  }

  // 5: the result.
  let after: VersionShare[];
  try {
    after = await currentDeployment(deps, worker);
  } catch (e) {
    return fail(`could not read the deployment after the move: ${(e as Error).message}`);
  }
  if (single(after) !== newId) return fail("the deployment does not show the new version at 100%");
  if (!(await workerHealthy(deps, worker, o.buildId))) {
    return fail(`${name} did not answer as expected after the release`);
  }
  say(deps, `${name} now serves ${newId} (build ${o.buildId})`);
  writeLedger(deps, o.ledgerPath, {
    kind: "release",
    worker: name,
    sha: o.sha,
    build_id: o.buildId,
    traffic: o.traffic,
    before,
    after,
    outcome: "released",
    run_url: url,
    at: at(),
  });
}

/* ------------------------------------------------------------------ */
/* Rollback                                                            */
/* ------------------------------------------------------------------ */

/**
 * Put an earlier version back at 100%: the deployment before the current one
 * (`previous`), or a named version id. Code and its secrets as they were when
 * that version was made; the database is not touched (migrations are
 * forward-only and additive, so earlier code still runs on it).
 */
export async function rollbackWorker(
  deps: GhDeps,
  worker: GhWorker,
  to: string,
  ledgerPath: string,
): Promise<void> {
  assertReleaseEnv(deps);
  const name = workerInfo[worker].name;
  const before = await currentDeployment(deps, worker);
  let target: VersionShare[];
  if (to === "previous") {
    const prev = previousDeployment(
      await wrangler(deps, worker, ["deployments", "list", "--json"]),
      before,
    );
    if (!prev) throw new GhRefusal(`${name} has no earlier deployment to go back to`);
    target = prev;
  } else if (uuid.test(to)) {
    target = [{ id: to, percentage: 100 }];
  } else {
    throw new GhRefusal("--to is previous or a version id");
  }
  if (sameShares(target, before)) throw new GhRefusal(`${name} already serves that`);
  say(deps, `== ${name}: back to ${target.map((s) => `${s.id}@${s.percentage}%`).join(", ")}`);
  const ok = await restore(
    deps,
    worker,
    target,
    `rollback from GitHub run ${deps.env.GITHUB_RUN_ID ?? ""}`.trim(),
  );
  const after = await currentDeployment(deps, worker).catch(() => [] as VersionShare[]);
  writeLedger(deps, ledgerPath, {
    kind: "rollback",
    worker: name,
    before,
    after,
    outcome: ok ? "rolled_back" : "rollback_failed",
    run_url: runUrl(deps),
    at: deps.now().toISOString(),
  });
  if (!ok) throw new GhFailure(`${name}: the rollback did not take`);
  say(deps, `${name} rolled back`);
}
