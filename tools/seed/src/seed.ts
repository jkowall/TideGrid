/**
 * Deterministic synthetic seed. Idempotent: running twice leaves the same state.
 * Grows with each goal; today it verifies the connection and migration state
 * because no domain tables exist yet. Never contains real people or businesses.
 */
import { createDb } from "@tidegrid/database";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (admin connection string).");
  process.exit(2);
}

const { db, end } = createDb(url, { max: 1 });
try {
  const rows = await db.selectFrom("schema_migrations").select("name").orderBy("name").execute();
  if (rows.length === 0) {
    console.error("No migrations applied. Run pnpm db:migrate first.");
    process.exit(1);
  }
  console.log(`schema at ${rows[rows.length - 1]?.name}; nothing to seed yet`);
} finally {
  await end();
}
