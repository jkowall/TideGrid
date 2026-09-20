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
  // Identifier is fixed; only the password is interpolated, as a literal.
  await sql.unsafe(`ALTER ROLE tidegrid_app LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
  const [row] = await sql<{ rolbypassrls: boolean; rolcreaterole: boolean }[]>`
    SELECT rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'tidegrid_app'`;
  if (!row || row.rolbypassrls || row.rolcreaterole) {
    console.error("tidegrid_app has elevated attributes; it must not bypass RLS or create roles.");
    process.exit(1);
  }
  console.log("tidegrid_app password set");
} finally {
  await sql.end();
}
