/**
 * The gate for the Playwright `deployed` modes (Nov 1 runbook, invariants 1
 * and 10). A deployed run drives a real host: it writes permanent synthetic
 * rows on Neon main and can carry an Access session. So it runs only from the
 * owner's own terminal, only through `nov1 accept`, which sets NOV1_GO, and
 * keeps every trace, screenshot, and session file in the owner-private
 * directory, outside the repository and outside ~/.claude.
 *
 * Node built-ins only: both Playwright configs import this file.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class DeployedGateRefusal extends Error {
  override name = "DeployedGateRefusal";
}

/** Gates that may start a deployed browser run: A5 (acceptance), A10 (cutover rerun of step 1). */
export const deployedGates = ["A5", "A10"] as const;

const refuse = (why: string): never => {
  throw new DeployedGateRefusal(`Deployed browser run refused: ${why}`);
};

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** A deployed base URL: https, a real host, no credentials, no path. */
export function deployedBaseUrl(raw: string | undefined, name = "E2E_BASE_URL"): URL {
  if (!raw) return refuse(`${name} is not set`);
  let url: URL;
  try {
    url = new URL(raw.replaceAll("{slug}", "slug"));
  } catch {
    return refuse(`${name} is not a URL`);
  }
  if (url.protocol !== "https:") refuse(`${name} must be https`);
  if (url.username || url.password) refuse(`${name} must not carry credentials`);
  if (url.port) refuse(`${name} must not name a port`);
  if (url.pathname !== "/" || url.search || url.hash) refuse(`${name} must be an origin only`);
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$|:/.test(host)) {
    refuse(`${name} names a local host; use the local modes for that`);
  }
  return url;
}

export interface GateInput {
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
}

/**
 * Checked in each deployed config's globalSetup, before any browser starts:
 * never in CI, only on a terminal, only with the go nov1 accept passes, and
 * never with the admin or disable variables the local journey uses.
 */
export function assertDeployedRunAllowed({ env, stdinIsTTY }: GateInput): string {
  if (env.CI) refuse("CI is set; deployed runs never run in CI");
  if (!stdinIsTTY) refuse("stdin is not a terminal; run it through nov1 accept");
  const go = env.NOV1_GO;
  if (!go || !(deployedGates as readonly string[]).includes(go)) {
    refuse(`NOV1_GO must be one of ${deployedGates.join(", ")}, set by nov1 accept`);
  }
  for (const name of ["E2E_ADMIN_DATABASE_URL", "E2E_DISABLE_HOST"]) {
    if (env[name]) refuse(`${name} is set; a deployed run never disables a host`);
  }
  return go as string;
}

export interface PrivateDirInput {
  env: Record<string, string | undefined>;
  repoRoot: string;
  home?: string;
}

/**
 * The owner-private directory: absolute, an existing directory, mode 0700 or
 * tighter, and outside the repository and ~/.claude, where agents read.
 */
export function privateDir({ env, repoRoot, home = homedir() }: PrivateDirInput): string {
  const raw = env.NOV1_PRIVATE_DIR;
  if (!raw) return refuse("NOV1_PRIVATE_DIR is not set");
  if (!isAbsolute(raw)) refuse("NOV1_PRIVATE_DIR must be an absolute path");
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    return refuse("NOV1_PRIVATE_DIR does not exist; create it with mode 0700");
  }
  const stat = statSync(real);
  if (!stat.isDirectory()) refuse("NOV1_PRIVATE_DIR is not a directory");
  if ((stat.mode & 0o077) !== 0) refuse("NOV1_PRIVATE_DIR must be mode 0700 (chmod 700)");
  const realRepo = safeReal(repoRoot);
  if (inside(real, realRepo)) refuse("NOV1_PRIVATE_DIR is inside the repository");
  const claude = safeReal(join(home, ".claude"));
  if (inside(real, claude)) refuse("NOV1_PRIVATE_DIR is inside ~/.claude, where agents read");
  return real;
}

function safeReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** A file that must live in the private directory, such as the Access storage state. */
export function privateFile(raw: string | undefined, dir: string, name: string): string {
  if (!raw) return refuse(`${name} is not set`);
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    return refuse(`${name} does not exist`);
  }
  const realDir = safeReal(dir);
  if (!inside(real, realDir) || real === realDir) {
    refuse(`${name} must be a file in NOV1_PRIVATE_DIR`);
  }
  if ((statSync(real).mode & 0o077) !== 0) refuse(`${name} must be mode 0600`);
  return real;
}
