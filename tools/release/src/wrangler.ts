/**
 * Wrangler, on the owner's terminal (invariant 4). With a non-TTY stdout a
 * custom-domain deploy sets override_existing_origin and
 * override_existing_dns_record (wrangler 4.135.0 cli.js:153833-153836), and
 * confirmations take their default answer. So every deploy, rollback, secret
 * put, and secret delete is spawned with stdio inherit, and version ids are
 * read in a separate `deployments list --json` call. Only ids are parsed: the
 * listing also carries each author's email (cli.js:348974,349090).
 */
import { join } from "node:path";
import { type Deps, Failure, Refusal } from "./core.ts";
import { announceStrip, childEnv } from "./env.ts";
import type { Worker } from "./journal.ts";
import { assertArgvSafe } from "./redact.ts";

export const workers: Record<Worker, { name: string; pkg: string; dir: string }> = {
  api: { name: "tidegrid-api", pkg: "@tidegrid/api-worker", dir: "apps/api-worker" },
  console: { name: "tidegrid-console", pkg: "@tidegrid/operator-site", dir: "apps/operator-site" },
  guest: { name: "tidegrid-guest", pkg: "@tidegrid/guest-site", dir: "apps/guest-site" },
};

export function parseWorker(raw: string | undefined): Worker {
  if (raw === "api" || raw === "console" || raw === "guest") return raw;
  throw new Refusal("name the Worker: api, console, or guest");
}

/** Run a command on the terminal, with a clean environment and a safe argv. */
export async function onTerminal(
  deps: Deps,
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; extraEnv?: Record<string, string> } = {},
): Promise<number> {
  assertArgvSafe(cmd, args);
  announceStrip(deps);
  const { code } = await deps.exec(cmd, args, {
    cwd: options.cwd ?? deps.repoRoot,
    env: childEnv(deps, options.extraEnv ?? {}),
    stdio: "inherit",
  });
  return code;
}

/** `wrangler <args>` from the Worker's own directory, on the terminal. */
export function wranglerOnTerminal(deps: Deps, worker: Worker, args: readonly string[]) {
  return onTerminal(deps, "pnpm", ["exec", "wrangler", ...args], {
    cwd: join(deps.repoRoot, workers[worker].dir),
  });
}

/** Captured output of a read-only wrangler listing, JSON only. */
async function wranglerJson(deps: Deps, worker: Worker, args: readonly string[]): Promise<unknown> {
  const all = ["exec", "wrangler", ...args];
  assertArgvSafe("pnpm", all);
  announceStrip(deps);
  const { code, stdout } = await deps.exec("pnpm", all, {
    cwd: join(deps.repoRoot, workers[worker].dir),
    env: childEnv(deps),
    stdio: "pipe",
  });
  if (code !== 0) throw new Failure(`wrangler ${args[0]} ${args[1] ?? ""} failed for ${worker}`);
  const start = stdout.search(/[[{]/);
  try {
    return JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    throw new Failure(`wrangler ${args[0]} for ${worker} did not print JSON`);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The version ids of the latest deployment, from `deployments list --json`
 * (sorted oldest first, cli.js:349049). Everything else in the listing is
 * dropped, the author email included.
 */
export function latestVersionIds(listing: unknown): string[] {
  if (!Array.isArray(listing) || listing.length === 0) return [];
  const last = listing[listing.length - 1] as { versions?: { version_id?: unknown }[] };
  return (last.versions ?? [])
    .map((v) => v.version_id)
    .filter((id): id is string => typeof id === "string" && uuid.test(id));
}

export async function deployedVersions(deps: Deps, worker: Worker): Promise<string[]> {
  return latestVersionIds(await wranglerJson(deps, worker, ["deployments", "list", "--json"]));
}

/** Secret names only, from `secret list` (JSON by default, cli.js:299246). */
export function secretNamesFrom(listing: unknown): string[] {
  if (!Array.isArray(listing)) return [];
  return listing
    .map((s) => (s as { name?: unknown }).name)
    .filter((n): n is string => typeof n === "string" && /^[A-Z][A-Z0-9_]*$/.test(n))
    .sort();
}

export async function secretNames(deps: Deps): Promise<string[]> {
  return secretNamesFrom(await wranglerJson(deps, "api", ["secret", "list", "--format", "json"]));
}
