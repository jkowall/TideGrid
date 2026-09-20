import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { Database } from "./types.ts";

export type { Database } from "./types.ts";

export interface DbOptions {
  /** Maximum connections. Workers keep this small; Hyperdrive pools upstream. */
  max?: number;
}

/**
 * Create a Kysely instance over postgres.js. In a Worker, create one per
 * request and pass `end()` to `ctx.waitUntil` so connections do not leak.
 *
 * Keep postgres.js on its defaults here. `fetch_types: false` makes the Kysely
 * dialect hang on the first query (bisected 2026-09-20 against Neon), and
 * `prepare: false` is unnecessary because Hyperdrive supports prepared
 * statements. The type fetch costs one round trip per connection, not per query.
 */
export function createDb(connectionString: string, options: DbOptions = {}) {
  const sql = postgres(connectionString, { max: options.max ?? 5 });
  const db = new Kysely<Database>({ dialect: new PostgresJSDialect({ postgres: sql }) });
  return {
    db,
    sql,
    end: async () => {
      await db.destroy();
      await sql.end({ timeout: 5 });
    },
  };
}
