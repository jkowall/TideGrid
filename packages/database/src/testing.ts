/**
 * Integration-test harness (Node only). Integration suites run against a
 * throwaway database: the local PostgreSQL 17 container that
 * tools/local-db/local-db.sh starts (CI uses the same script), or optionally a
 * throwaway Neon branch. They migrate it, rotate the runtime role's password
 * on it, and connect twice, once as the admin role for fixtures and once as
 * tidegrid_app so row-level security is exercised for real.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { migrate } from "./migrate.ts";
import { newRuntimePassword, runtimeUrlFrom, setRuntimeRolePassword } from "./role.ts";

export interface IntegrationDatabase {
  /** Owner connection: bypasses row-level security. Fixtures only. */
  adminUrl: string;
  /** tidegrid_app connection: the role every Worker request uses. */
  runtimeUrl: string;
}

/**
 * The admin URL for integration tests, or null to skip locally. In CI a missing
 * URL is an error so the suite can never pass by not running.
 */
export function integrationAdminUrl(source: NeonGuardSource = defaultSource()): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.CI) {
      throw new Error(
        'DATABASE_URL is required in CI; integration suites must not skip silently. Use pnpm test:local-db, or tools/local-db/local-db.sh up and then eval "$(tools/local-db/local-db.sh env)".',
      );
    }
    return null;
  }
  if (process.env.TIDEGRID_EPHEMERAL_DB !== "1") {
    throw new Error(
      "Integration suites rotate the runtime role password. Point DATABASE_URL at a throwaway database (tools/local-db/local-db.sh up, or a throwaway Neon branch) and set TIDEGRID_EPHEMERAL_DB=1.",
    );
  }
  assertNotNeonMain(url, "tests", source);
  return url;
}

export async function prepareIntegrationDatabase(adminUrl: string): Promise<IntegrationDatabase> {
  // Also checked here, for a caller that skips integrationAdminUrl().
  assertNotNeonMain(adminUrl, "tests");
  await step("migrate the database", 120_000, () => migrate(adminUrl));
  const password = newRuntimePassword();
  await step("rotate the runtime password", 60_000, () =>
    setRuntimeRolePassword(adminUrl, password),
  );
  const runtimeUrl = runtimeUrlFrom(adminUrl, password);
  // Neon applies a role change through its control plane; give it a moment.
  // A plain PostgreSQL applies it at commit, so only a Neon host waits.
  if (connectionHosts(adminUrl)?.some(isNeonHostName))
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  await waitUntilReachable([adminUrl, runtimeUrl]);
  return { adminUrl, runtimeUrl };
}

/** True when the URL's host is a Neon endpoint, such as ep-x.us-east-2.aws.neon.tech. */
export function isNeonHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return host === "neon.tech" || host.endsWith(".neon.tech");
}

// ---------------------------------------------------------------------------
// Neon main guard.
//
// Integration suites and app-role:password both rotate tidegrid_app's
// password. On Neon main that breaks Hyperdrive (Nov 1 runbook rule 4). The
// guard refuses a connection whose host is the recorded main host, and, while
// no main host is recorded, any Neon host not marked as a throwaway branch.
// Its messages name the rule and the flag; they never echo a host or a URL.
// ---------------------------------------------------------------------------

/** Where the guard reads its inputs. Injected in unit tests. */
export interface NeonGuardSource {
  env: NodeJS.ProcessEnv;
  /** The repository root .env.local, or null when there is none. */
  readEnvLocal: () => string | null;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readRootEnvLocal(): string | null {
  try {
    return readFileSync(join(repoRoot, ".env.local"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Fail closed: an unreadable file could hold the main host.
    throw new Error("Refused: the repository root .env.local exists but could not be read.");
  }
}

const defaultSource = (): NeonGuardSource => ({ env: process.env, readEnvLocal: readRootEnvLocal });

/** One DNS name, with an optional trailing dot. No scheme, port, path, or credentials. */
const hostNamePattern =
  /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

/**
 * Lowercase, no trailing dot, and a Neon pooled endpoint folded onto its
 * direct endpoint (ep-x-pooler.region.aws.neon.tech and ep-x.region.aws.neon.tech
 * reach the same compute).
 */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.$/, "");
  if (isNeonHostName(h)) {
    const dot = h.indexOf(".");
    const first = dot === -1 ? h : h.slice(0, dot);
    if (first.endsWith("-pooler")) h = first.slice(0, -"-pooler".length) + h.slice(first.length);
  }
  return h;
}

type Recorded =
  | { kind: "missing" }
  | { kind: "malformed"; where: string }
  | { kind: "set"; hosts: string[] };

/**
 * The recorded main host, from NEON_MAIN_HOST in the environment and in the
 * repository root .env.local (gitignored). When both are set, a match with
 * either counts. A blank value counts as unset.
 */
export function recordedNeonMainHost(source: NeonGuardSource = defaultSource()): Recorded {
  const values: { where: string; value: string }[] = [];
  const fromEnv = source.env.NEON_MAIN_HOST?.trim();
  if (fromEnv) values.push({ where: "the environment", value: fromEnv });
  const text = source.readEnvLocal();
  if (text !== null) {
    let parsed: Record<string, string | undefined>;
    try {
      parsed = parseEnv(text) as Record<string, string | undefined>;
    } catch {
      return { kind: "malformed", where: ".env.local" };
    }
    const fromFile = parsed.NEON_MAIN_HOST?.trim();
    if (fromFile) values.push({ where: ".env.local", value: fromFile });
  }
  if (values.length === 0) return { kind: "missing" };
  for (const { where, value } of values) {
    if (!hostNamePattern.test(value)) return { kind: "malformed", where };
  }
  return { kind: "set", hosts: values.map((v) => normalizeHost(v.value)) };
}

/**
 * Every host a postgres.js client would reach for this URL: the URL's hosts
 * (postgres.js accepts a comma-separated list), or PGHOST, or localhost when
 * the URL names none. Null when the URL does not parse. The error a failed
 * parse throws carries the URL itself, so it is never rethrown.
 *
 * Two parses are joined: a WHATWG one, and a copy of postgres.js 3.4.9's own
 * (parseUrl and parseOptions), which cuts at the first '@', does not treat '#'
 * as a delimiter, and percent-decodes the host list. A host either parse finds
 * counts, so a crafted URL cannot hide a host from the guard that postgres.js
 * would still try. A unit test checks nine fixed URLs against the installed
 * client: every host it lists must be one this function returns. It proves
 * nothing about other URLs, so recheck the copy when postgres.js moves.
 */
export function connectionHosts(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  const whatwg = whatwgHosts(url);
  const client = postgresJsHosts(url, env);
  if (whatwg === null || client === null) return null;
  const hosts = whatwg.length > 0 ? whatwg : envHosts(env);
  return [...new Set([...hosts, ...client].map(normalizeHost))];
}

/** The URL's own hosts by a WHATWG parse, [] when it names none, null when it does not parse. */
function whatwgHosts(url: string): string[] | null {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return null;
  let authority = url.slice(schemeEnd + 3).split(/[?/#]/)[0] ?? "";
  authority = authority.slice(authority.lastIndexOf("@") + 1);
  const hosts: string[] = [];
  try {
    if (authority.includes(",")) {
      const parts = authority.split(",");
      for (const part of parts) hosts.push(new URL(`postgresql://${part}`).hostname);
      if (hosts.some((h) => h === "")) return null;
      // The whole URL must parse too, with the first host in place of the list.
      new URL(url.replace(authority, parts[0] as string));
    } else {
      const host = new URL(url).hostname;
      if (host !== "") hosts.push(host);
    }
  } catch {
    return null;
  }
  return hosts;
}

/** PGHOST's hosts, or localhost. */
function envHosts(env: NodeJS.ProcessEnv): string[] {
  const pgHost = env.PGHOST?.trim();
  if (pgHost) return pgHost.split(",").map((h) => h.split(":")[0] ?? "");
  return ["localhost"];
}

/** The host list postgres.js 3.4.9 builds for a URL with no options, or null when it would throw. */
function postgresJsHosts(url: string, env: NodeJS.ProcessEnv): string[] | null {
  try {
    let host = url.slice(url.indexOf("://") + 3).split(/[?/]/)[0] ?? "";
    host = decodeURIComponent(host.slice(host.indexOf("@") + 1));
    const parsed = new URL(url.replace(host, host.split(",")[0] ?? ""));
    const multihost = host.includes(",") ? host : "";
    const list = multihost || parsed.hostname || env.PGHOST || "localhost";
    return list.split(",").map((x) => x.split(":")[0] ?? "");
  } catch {
    return null;
  }
}

export type NeonGuardMode = "tests" | { appRole: { neonMain: boolean } };

const rule4 =
  "It rotates tidegrid_app's password, which breaks Hyperdrive on Neon main (Nov 1 runbook rule 4)";
const recordHint =
  "Record the main branch's host as NEON_MAIN_HOST in the repository root .env.local (gitignored) or the environment";

/**
 * Why `url` must not be used in this mode, or null when it may. The message
 * names the rule and any flag that applies, never the host or the URL.
 */
export function neonMainRefusal(
  url: string,
  mode: NeonGuardMode,
  source: NeonGuardSource = defaultSource(),
): string | null {
  const what = mode === "tests" ? "Integration suites" : "app-role:password";
  const hosts = connectionHosts(url, source.env);
  if (hosts === null) {
    return `Refused: DATABASE_URL is not a valid connection URL, so ${what} cannot tell whether it is Neon main. Its value is not shown.`;
  }
  let recorded: Recorded;
  try {
    recorded = recordedNeonMainHost(source);
  } catch (err) {
    return (err as Error).message;
  }
  if (recorded.kind === "malformed") {
    return `Refused: NEON_MAIN_HOST in ${recorded.where} is not a bare host name (no scheme, user, port, or path), so ${what} cannot tell whether DATABASE_URL is Neon main. Its value is not shown. Fix it, or remove it.`;
  }
  const neon = hosts.some(isNeonHostName);
  const isMain = recorded.kind === "set" ? hosts.some((h) => recorded.hosts.includes(h)) : null;
  const branchFlag = source.env.TIDEGRID_NEON_BRANCH === "1";

  if (mode === "tests") {
    if (isMain) {
      return `Refused: DATABASE_URL is the Neon main host recorded in NEON_MAIN_HOST. Integration suites never run against Neon main, even with TIDEGRID_EPHEMERAL_DB=1. ${rule4}. Use tools/local-db/local-db.sh, or a throwaway branch from neon:branch.`;
    }
    if (recorded.kind === "missing" && neon && !branchFlag) {
      return `Refused: DATABASE_URL is a Neon host and NEON_MAIN_HOST is not recorded, so it could be Neon main. Integration suites never run against Neon main. ${rule4}. For a throwaway branch from neon:branch, also set TIDEGRID_NEON_BRANCH=1. ${recordHint}.`;
    }
    return null;
  }

  const { neonMain } = mode.appRole;
  if (neonMain) {
    if (recorded.kind === "missing" && !neon) {
      return "Refused: --neon-main was given, but DATABASE_URL is not a Neon host. Drop --neon-main for any other database.";
    }
    if (!neon || isMain === false) {
      return "Refused: --neon-main was given, but DATABASE_URL is not the Neon main host recorded in NEON_MAIN_HOST. Check both; drop --neon-main for any other database.";
    }
    return null;
  }
  if (isMain) {
    return `Refused: DATABASE_URL is the Neon main host recorded in NEON_MAIN_HOST. A new password there breaks Hyperdrive until its config and the DATABASE_URL secret carry it (Nov 1 runbook rule 4). Pass --neon-main to do this on purpose.`;
  }
  if (recorded.kind === "missing" && neon && !branchFlag) {
    return `Refused: DATABASE_URL is a Neon host and NEON_MAIN_HOST is not recorded, so it could be Neon main. ${rule4}. Pass --neon-main to do this on main on purpose, or set TIDEGRID_NEON_BRANCH=1 for a throwaway branch. ${recordHint}.`;
  }
  return null;
}

/** Throw the refusal, if any. */
export function assertNotNeonMain(
  url: string,
  mode: NeonGuardMode,
  source: NeonGuardSource = defaultSource(),
): void {
  const refusal = neonMainRefusal(url, mode, source);
  if (refusal) throw new Error(refusal);
}

/** isNeonHost() for a bare host name. False, never a throw, for one that does not parse. */
function isNeonHostName(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "neon.tech" || h.endsWith(".neon.tech")) return true;
  try {
    return isNeonHost(`postgresql://${host}`);
  } catch {
    return false;
  }
}

/**
 * Vitest gives global setup no timeout, so a stalled await would hang the run
 * with no output. Every setup step fails with its name instead.
 */
async function step<T>(name: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Integration setup could not ${name} within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Integration runs on Neon have occasionally stalled on connect, or failed
 * their first queries, just after this setup rotated the runtime password.
 * Wait until both roles answer. Each attempt has a hard limit and its client is
 * torn down when it expires, so a stalled login cannot hang the run.
 */
async function waitUntilReachable(urls: readonly string[], deadlineMs = 120_000): Promise<void> {
  const started = Date.now();
  for (const url of urls) {
    for (let attempt = 1; ; attempt++) {
      const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
      try {
        await step("reach the database", 15_000, () => sql`select 1`);
        break;
      } catch (err) {
        if (Date.now() - started > deadlineMs) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * attempt, 5_000)));
      } finally {
        await sql.end({ timeout: 0 });
      }
    }
  }
}
