import type { ColumnType, Generated } from "kysely";

/**
 * Database types grow with each reviewed migration. Keep this file in step with
 * `migrations/`; a mismatch is a review finding.
 */
export interface SchemaMigrationsTable {
  name: string;
  checksum: string;
  applied_at: ColumnType<Date, string | undefined, never>;
}

export interface Database {
  schema_migrations: SchemaMigrationsTable;
}

export type { Generated };
