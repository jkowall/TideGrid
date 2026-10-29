/**
 * Create or delete a Neon branch: an expiring throwaway branch for integration
 * tests, or a compute-less, non-expiring backup branch for a release.
 *
 *   NEON_API_KEY=... NEON_PROJECT_ID=... tsx src/neon-branch.ts create <name> [options]
 *   NEON_API_KEY=... NEON_PROJECT_ID=... tsx src/neon-branch.ts delete <branch-id>
 *
 * Options for `create`:
 *   --ttl <hours>    expire after this many hours (default 6, at most 720)
 *   --no-expiry      never expire; for a restore point only, never with --ttl
 *   --no-endpoint    create no compute; the branch cannot be connected to until
 *                    one is added, so no connection string exists to fetch
 *   --out <file>     write {"branchId","connectionString"} to this file with
 *                    mode 0600; the file must not exist yet
 *
 * `create` prints only `{"branchId": ...}`. The admin connection string goes to
 * --out when given and is otherwise never fetched, so it cannot reach a
 * terminal's scrollback or a log. Branches inherit roles and data from the
 * parent (main) at creation time.
 */
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const api = "https://console.neon.tech/api/v2";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface NeonDeps {
  fetch: Fetch;
  env: NodeJS.ProcessEnv;
}

const defaultDeps = (): NeonDeps => ({ fetch: globalThis.fetch, env: process.env });

function required(deps: NeonDeps, name: string): string {
  const v = deps.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function neon<T>(deps: NeonDeps, path: string, init: RequestInit = {}): Promise<T> {
  const res = await deps.fetch(`${api}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${required(deps, "NEON_API_KEY")}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  // The status only: an error body could echo request details.
  if (!res.ok) throw new Error(`Neon ${init.method ?? "GET"} ${path} -> ${res.status}`);
  // Some responses (for example deleting a branch Neon already expired) have no body.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

interface CreateResponse {
  branch: { id: string };
}

/**
 * The project's default compute is fixed at 0.25 CU (about 1 GB), and the
 * race suites' 20 to 30 concurrent sessions ran it out of memory (53200).
 * Throwaway branches may scale up to 1 CU under that load and back down when
 * idle. The cap bounds what a test run can spend.
 */
const branchCompute = { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 1 };

export interface CreateOptions {
  /** Seconds until Neon deletes the branch, or null for no expiry. */
  ttlSeconds: number | null;
  endpoint: boolean;
  /** Fetch the admin connection string. Only when it has somewhere private to go. */
  withConnectionString: boolean;
}

export const defaultTtlHours = 6;

/** The request body for a new branch. Exported for the unit test. */
export function createBody(name: string, options: CreateOptions, now = Date.now()) {
  return {
    branch: {
      name,
      ...(options.ttlSeconds === null
        ? {}
        : { expires_at: new Date(now + options.ttlSeconds * 1000).toISOString() }),
    },
    ...(options.endpoint ? { endpoints: [{ type: "read_write", ...branchCompute }] } : {}),
  };
}

export async function createBranch(
  name: string,
  options: CreateOptions = {
    ttlSeconds: defaultTtlHours * 3600,
    endpoint: true,
    withConnectionString: true,
  },
  deps: NeonDeps = defaultDeps(),
): Promise<{ branchId: string; connectionString: string | null }> {
  if (options.withConnectionString && !options.endpoint) {
    throw new Error("a branch without an endpoint has no connection string to fetch");
  }
  const project = required(deps, "NEON_PROJECT_ID");
  const created = await neon<CreateResponse>(deps, `/projects/${project}/branches`, {
    method: "POST",
    body: JSON.stringify(createBody(name, options)),
  });
  const branchId = created.branch.id;
  if (!options.withConnectionString) return { branchId, connectionString: null };
  const uri = await neon<{ uri: string }>(
    deps,
    `/projects/${project}/connection_uri?branch_id=${branchId}&role_name=neondb_owner&database_name=neondb&pooled=false`,
  );
  return { branchId, connectionString: uri.uri };
}

/** Idempotent: a branch that is already gone (deleted or expired) counts as deleted. */
export async function deleteBranch(branchId: string, deps: NeonDeps = defaultDeps()) {
  const project = required(deps, "NEON_PROJECT_ID");
  try {
    await neon(deps, `/projects/${project}/branches/${branchId}`, { method: "DELETE" });
  } catch (err) {
    if (!/-> 404$/.test((err as Error).message)) throw err;
  }
}

export interface CreateArgs {
  name: string;
  options: CreateOptions;
  out: string | null;
}

const namePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** Parse `create` arguments. Exported for the unit test. */
export function parseCreateArgs(args: readonly string[], now = Date.now()): CreateArgs {
  let name: string | null = null;
  let ttlHours: number | null = null;
  let noExpiry = false;
  let endpoint = true;
  let out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--ttl") {
      const raw = args[++i] ?? "";
      if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 720) {
        throw new Error("--ttl takes whole hours from 1 to 720");
      }
      ttlHours = Number(raw);
    } else if (arg === "--no-expiry") noExpiry = true;
    else if (arg === "--no-endpoint") endpoint = false;
    else if (arg === "--out") {
      out = args[++i] ?? null;
      if (!out || out.startsWith("--")) throw new Error("--out needs a file path");
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else if (name === null) name = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (noExpiry && ttlHours !== null) throw new Error("--no-expiry and --ttl contradict");
  const branchName = name ?? `ci-${now}`;
  if (!namePattern.test(branchName)) {
    throw new Error("branch names are lowercase letters, digits, dot, dash, and underscore");
  }
  if (out && !endpoint) throw new Error("--out needs an endpoint: --no-endpoint has no URI");
  return {
    name: branchName,
    options: {
      ttlSeconds: noExpiry ? null : (ttlHours ?? defaultTtlHours) * 3600,
      endpoint,
      withConnectionString: out !== null,
    },
    out,
  };
}

/** Write the secret file with mode 0600, refusing to replace an existing file. */
async function writePrivate(path: string, body: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(body);
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , command, ...rest] = process.argv;
  if (command === "create") {
    const { name, options, out } = parseCreateArgs(rest);
    const result = await createBranch(name, options);
    if (out) {
      await writePrivate(out, `${JSON.stringify(result)}\n`);
    }
    console.log(JSON.stringify({ branchId: result.branchId }));
  } else if (command === "delete") {
    const [arg] = rest;
    if (!arg) throw new Error("branch id required");
    await deleteBranch(arg);
    console.log(JSON.stringify({ deleted: arg }));
  } else if (command) {
    console.error(
      "usage: neon-branch.ts create <name> [--ttl <hours> | --no-expiry] [--no-endpoint] [--out <file>] | delete <branch-id>",
    );
    process.exit(2);
  }
}
