/**
 * Effects for the GitHub release path (release.yml). Every effect goes
 * through GhDeps, so the unit tests run the whole flow with a fake wrangler,
 * a fake Cloudflare API, and fake hosts.
 *
 * This path is separate from nov1 on purpose. nov1 never runs a live step
 * under CI and always needs a terminal. Here the owner's one approval on the
 * GitHub `production` environment is the go, and wrangler runs only the
 * commands that cannot touch DNS or custom domains (`versions upload` and
 * `versions deploy`), so no terminal is needed.
 */
import { redact } from "../redact.ts";

export type Env = Record<string, string | undefined>;

export interface GhExecResult {
  code: number;
  stdout: string;
}

export interface GhDeps {
  /**
   * Run a command. stdout is captured and returned; stderr goes to the job
   * log. `env` is the child's whole environment (see childEnv).
   */
  exec: (
    cmd: string,
    args: readonly string[],
    options: { cwd: string; env: Env },
  ) => Promise<GhExecResult>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  env: Env;
  print: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  repoRoot: string;
  readFile: (path: string) => string;
  appendFile: (path: string, text: string) => void;
  /** A fresh temporary file path for wrangler's output file. */
  tempPath: (name: string) => string;
}

/** Stops before anything changed. Exit 3. */
export class GhRefusal extends Error {
  override name = "GhRefusal";
}

/** Failed after acting, or an expectation not met. Exit 1. */
export class GhFailure extends Error {
  override name = "GhFailure";
}

export function say(deps: GhDeps, line = ""): void {
  deps.print(redact(line));
}

/** Names a wrangler child may inherit. The token is passed on purpose, nothing else. */
const inherited = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "RUNNER_TEMP",
  "CI",
  "PNPM_HOME",
  "COREPACK_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
] as const;

export function childEnv(deps: GhDeps, extra: Record<string, string> = {}): Env {
  const env: Env = {};
  for (const name of inherited) {
    const v = deps.env[name];
    if (v !== undefined && v !== "") env[name] = v;
  }
  // No usage metrics from a release job.
  env.WRANGLER_SEND_METRICS = "false";
  return { ...env, ...extra };
}

/** A build child's environment: like childEnv, without the Cloudflare names. */
export function buildEnv(deps: GhDeps): Env {
  const env = childEnv(deps);
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  return env;
}

/** Build-time inputs that would bake a local setting into a release bundle. */
export const buildLeakNames = [
  "VITE_API_BASE",
  "GUEST_LOCAL_API",
  "GUEST_SW_KILL_SWITCH",
  "VITE_DEMO_MAILBOX",
] as const;
