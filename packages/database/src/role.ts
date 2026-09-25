import { randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * Runtime role administration (Node only; never bundled into a Worker).
 *
 * Neon forwards role changes to its control plane and accepts only plaintext
 * passwords ("Neon only supports being given plaintext passwords", observed
 * 2026-09-23), so a precomputed SCRAM verifier is not an option here. The
 * password is sent once, over TLS, as a quoted literal.
 */

/** base64url only: nothing that could interact with SQL string quoting. */
const passwordAlphabet = /^[A-Za-z0-9_-]+$/;

type Sql = ReturnType<typeof postgres>;

/**
 * Everything that makes `role` more than the plain login role migration 0001
 * creates, or null when the role does not exist. Any membership counts, not
 * only neon_superuser: SET ROLE to a table owner, or to any role that is itself
 * in neon_superuser, reaches BYPASSRLS. Any ownership counts, because an owner
 * can alter what it owns and a schema owner can drop anything in the schema.
 */
export async function runtimeRoleFindings(
  sql: Sql,
  role = "tidegrid_app",
): Promise<string[] | null> {
  const [row] = await sql<{ attributes: string[]; member_of: string[]; owns: string[] }[]>`
    SELECT array_remove(ARRAY[
             CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
             CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
             CASE WHEN r.rolcreatedb THEN 'CREATEDB' END,
             CASE WHEN r.rolreplication THEN 'REPLICATION' END,
             CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END
           ], NULL) AS attributes,
           array(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                  WHERE m.member = r.oid ORDER BY 1) AS member_of,
           array_remove(ARRAY[
             CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datdba = r.oid) THEN 'database' END,
             CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid) THEN 'schema' END,
             CASE WHEN EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid) THEN 'relation' END,
             CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proowner = r.oid) THEN 'function' END,
             CASE WHEN EXISTS (SELECT 1 FROM pg_type WHERE typowner = r.oid) THEN 'type' END
           ], NULL) AS owns
      FROM pg_roles r WHERE r.rolname = ${role}`;
  if (!row) return null;
  const findings: string[] = [];
  if (row.attributes.length > 0) findings.push(`has ${row.attributes.join(", ")}`);
  if (row.member_of.length > 0) findings.push(`is a member of ${row.member_of.join(", ")}`);
  if (row.owns.length > 0) findings.push(`owns a ${row.owns.join(", a ")}`);
  return findings;
}

/**
 * Refuse to continue unless tidegrid_app is the plain role from migration
 * 0001. The migration runner checks before and after every run, and the
 * password command checks before it issues a credential. A role created
 * through the Neon console or API joins neon_superuser, which bypasses
 * row-level security.
 */
export async function assertRuntimeRoleIsPlain(
  sql: Sql,
  { mustExist = true }: { mustExist?: boolean } = {},
): Promise<void> {
  const findings = await runtimeRoleFindings(sql);
  if (findings === null) {
    if (mustExist) throw new Error("tidegrid_app does not exist; run migrations first.");
    return;
  }
  if (findings.length > 0) {
    throw new Error(
      `tidegrid_app is not the plain role migration 0001 creates: it ${findings.join("; it ")}. Revoke these. On a database with no migrations applied, dropping the role lets 0001 recreate it.`,
    );
  }
}

export async function setRuntimeRolePassword(adminUrl: string, password: string): Promise<void> {
  if (password.length < 24 || !passwordAlphabet.test(password)) {
    throw new RangeError("runtime role password must be 24+ base64url characters");
  }
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await assertRuntimeRoleIsPlain(sql);
    // ALTER ROLE takes no bind parameters. The alphabet check above rules out
    // quotes and backslashes, so the literal cannot be broken out of.
    await sql.unsafe(`ALTER ROLE tidegrid_app LOGIN PASSWORD '${password}'`);
  } finally {
    await sql.end();
  }
}

export function newRuntimePassword(): string {
  return randomBytes(32).toString("base64url");
}

/** The admin URL with the runtime role's credentials substituted. */
export function runtimeUrlFrom(adminUrl: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = "tidegrid_app";
  url.password = password;
  return url.toString();
}
