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
 * Refuse to issue a credential unless tidegrid_app is the plain role from
 * migration 0001. A role created through the Neon console or API joins
 * neon_superuser, which bypasses row-level security.
 */
export async function assertRuntimeRoleIsPlain(sql: Sql): Promise<void> {
  const [row] = await sql<
    {
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      groups: string[];
    }[]
  >`
    SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
           array(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid
                 WHERE m.member = r.oid) AS groups
      FROM pg_roles r WHERE r.rolname = 'tidegrid_app'`;
  if (!row) throw new Error("tidegrid_app does not exist; run migrations first.");
  const elevated = row.rolsuper || row.rolbypassrls || row.rolcreaterole || row.rolcreatedb;
  const privilegedGroups = row.groups.filter((g) => g === "neon_superuser" || g.startsWith("pg_"));
  if (elevated || privilegedGroups.length > 0) {
    throw new Error(
      `tidegrid_app is elevated (attributes: ${elevated}; groups: ${privilegedGroups.join(", ") || "none"}). Drop it and let migration 0001 recreate it.`,
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
