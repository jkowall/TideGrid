import { createDb } from "@tidegrid/database";
import type { Context } from "hono";
import type { AppEnv } from "./context.ts";
import { databaseUrl } from "./env.ts";
import { ApiError } from "./errors.ts";

/**
 * One connection per request, created on first use. With Hyperdrive the
 * connection is pooled at the edge; the app-level pool stays at one. The
 * request middleware closes it after the response.
 */
export function getDb(c: Context<AppEnv>) {
  let handle = c.get("dbHandle");
  if (!handle) {
    const url = databaseUrl(c.env);
    if (!url) throw new ApiError(503, "database_unconfigured", "The database is not configured");
    handle = createDb(url, { max: 1 });
    c.set("dbHandle", handle);
  }
  return handle.db;
}

export function releaseDb(c: Context<AppEnv>): void {
  const handle = c.get("dbHandle");
  if (handle) c.executionCtx.waitUntil(handle.end().catch(() => undefined));
}
