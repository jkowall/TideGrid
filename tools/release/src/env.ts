/**
 * Child environments (invariant 7). Every child gets an environment built from
 * an allowlist, plus the few names a command passes on purpose. Anything else
 * in the owner's shell, a sourced env file included, never reaches a child.
 */
import { type Deps, type Env, out, Refusal } from "./core.ts";

/** Names a child may inherit from the owner's shell. No secrets. */
export const inheritedNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "COREPACK_HOME",
  "PNPM_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  // Not a secret: picks the account when the OAuth login can reach several.
  "CLOUDFLARE_ACCOUNT_ID",
] as const;

/**
 * Stripped from every child, and the strip is printed. Releases use the
 * wrangler OAuth login: the recorded token's scopes lack Workers Scripts edit,
 * and sourcing the owner's env file exports it.
 */
export const strippedNames = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"] as const;

/** Build-time inputs that would bake into a release (bootstrap.ts:8-10, vite.config.ts:38). */
export const buildLeakNames = [
  "VITE_API_BASE",
  "GUEST_LOCAL_API",
  "GUEST_SW_KILL_SWITCH",
  "VITE_DEMO_MAILBOX",
] as const;

/** Names that make a database command unsafe on a shared database (invariant 8). */
export const dbHazardNames = [
  "TIDEGRID_EPHEMERAL_DB",
  "TIDEGRID_APP_PASSWORD",
  "SEED_LOCAL_HOSTNAMES",
  "E2E_ADMIN_DATABASE_URL",
] as const;

export function present(env: Env, name: string): boolean {
  const v = env[name];
  return v !== undefined && v !== "";
}

/** The child's environment: the allowlist from the owner's shell, plus `extra`. */
export function childEnv(deps: Deps, extra: Env = {}): Env {
  const env: Env = {};
  for (const name of inheritedNames) {
    if (present(deps.env, name)) env[name] = deps.env[name];
  }
  for (const [name, value] of Object.entries(extra)) {
    if ((strippedNames as readonly string[]).includes(name)) {
      throw new Refusal(`${name} is never passed to a child`);
    }
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Print the strip once per wrangler call, so the owner sees the login wrangler will use. */
export function announceStrip(deps: Deps): void {
  for (const name of strippedNames) {
    if (present(deps.env, name)) out(deps, `${name} stripped: wrangler uses the OAuth login.`);
  }
}

/** Refuse when a build-time leak is set; the kill-switch rollback may allow its one name. */
export function assertNoBuildLeak(deps: Deps, allow: readonly string[] = []): void {
  const set = buildLeakNames.filter((n) => present(deps.env, n) && !allow.includes(n));
  if (set.length > 0) {
    throw new Refusal(
      `unset ${set.join(", ")} first: each would bake into a release build. Run in a fresh shell.`,
    );
  }
}

/** Refuse when a name that rotates tidegrid_app, or seeds local hosts, is in the shell. */
export function assertNoDbHazard(deps: Deps, options: { allowDemoBookings: boolean }): void {
  const set: string[] = dbHazardNames.filter((n) => present(deps.env, n));
  if (present(deps.env, "SEED_DEMO_BOOKINGS") && !options.allowDemoBookings) {
    set.push("SEED_DEMO_BOOKINGS (D14 is not b)");
  }
  if (set.length > 0) {
    throw new Refusal(
      `refused: ${set.join(", ")} set in this shell. Integration setup rotates tidegrid_app, app-role has no guard, and local hostnames are permanent once disabled. Unset them.`,
    );
  }
}
