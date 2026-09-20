/**
 * Set the runtime role's password from the environment. Run once per database
 * (main branch and long-lived staging) after the first migration; branches
 * inherit it. Uses the admin connection.
 *
 *   DATABASE_URL=... TIDEGRID_APP_PASSWORD=... tsx src/app-role.ts
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
const password = process.env.TIDEGRID_APP_PASSWORD;
if (!url || !password) {
  console.error("DATABASE_URL and TIDEGRID_APP_PASSWORD are required.");
  process.exit(2);
}
if (password.length < 24) {
  console.error("TIDEGRID_APP_PASSWORD must be at least 24 characters.");
  process.exit(2);
}
const sql = postgres(url, { max: 1 });
try {
  // Refuse before issuing any credential: the role must be the plain SQL role
  // from migration 0001, never a Neon console role (which joins neon_superuser).
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
  if (!row) {
    console.error("tidegrid_app does not exist; run migrations first.");
    process.exit(1);
  }
  const elevated = row.rolsuper || row.rolbypassrls || row.rolcreaterole || row.rolcreatedb;
  const privilegedGroups = row.groups.filter((g) => g === "neon_superuser" || g.startsWith("pg_"));
  if (elevated || privilegedGroups.length > 0) {
    console.error(
      `tidegrid_app is elevated (attributes: ${elevated}; groups: ${privilegedGroups.join(", ") || "none"}). Drop it and let migration 0001 recreate it.`,
    );
    process.exit(1);
  }
  // Identifier is fixed; only the password is interpolated, as a quoted literal.
  await sql.unsafe(`ALTER ROLE tidegrid_app LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
  console.log("tidegrid_app password set");
} finally {
  await sql.end();
}
