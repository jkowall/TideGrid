/**
 * Create or delete an expiring Neon branch for CI or local integration tests.
 *
 *   NEON_API_KEY=... NEON_PROJECT_ID=... tsx src/neon-branch.ts create <name>
 *   NEON_API_KEY=... NEON_PROJECT_ID=... tsx src/neon-branch.ts delete <branch-id>
 *
 * `create` prints JSON with `branchId` and `connectionString` (admin role).
 * Branches inherit roles and data from the parent (main) at creation time.
 */

const api = "https://console.neon.tech/api/v2";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function neon<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("NEON_API_KEY")}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok)
    throw new Error(`Neon ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface CreateResponse {
  branch: { id: string };
  connection_uris?: { connection_uri: string }[];
}

export async function createBranch(name: string, ttlSeconds = 6 * 3600) {
  const project = env("NEON_PROJECT_ID");
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const created = await neon<CreateResponse>(`/projects/${project}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch: { name, expires_at: expires },
      endpoints: [{ type: "read_write" }],
    }),
  });
  const branchId = created.branch.id;
  const uri = await neon<{ uri: string }>(
    `/projects/${project}/connection_uri?branch_id=${branchId}&role_name=neondb_owner&database_name=neondb&pooled=false`,
  );
  return { branchId, connectionString: uri.uri };
}

export async function deleteBranch(branchId: string) {
  const project = env("NEON_PROJECT_ID");
  await neon(`/projects/${project}/branches/${branchId}`, { method: "DELETE" });
}

const [, , command, arg] = process.argv;
if (command === "create") {
  const name = arg ?? `ci-${Date.now()}`;
  const result = await createBranch(name);
  console.log(JSON.stringify(result));
} else if (command === "delete") {
  if (!arg) throw new Error("branch id required");
  await deleteBranch(arg);
  console.log(JSON.stringify({ deleted: arg }));
} else if (command) {
  console.error("usage: neon-branch.ts create <name> | delete <branch-id>");
  process.exit(2);
}
