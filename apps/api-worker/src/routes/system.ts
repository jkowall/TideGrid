import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { apiVersion, HealthResponse } from "@tidegrid/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { databaseUrl } from "../env.ts";
import { errorBody } from "./responses.ts";

// The health endpoint is public. Memoize the database probe per isolate so a
// request burst cannot open a connection per request against a scale-to-zero branch.
let probeCache: {
  at: number;
  value: Pick<HealthResponse, "status" | "database" | "migrations">;
} | null = null;
const probeTtlMs = 10_000;

export function registerSystemRoutes(app: OpenAPIHono<AppEnv>) {
  const health = createRoute({
    method: "get",
    path: `/${apiVersion}/health`,
    tags: ["system"],
    summary: "Service health",
    responses: {
      200: {
        content: { "application/json": { schema: HealthResponse } },
        description: "Healthy or degraded",
      },
      500: errorBody("Failure"),
    },
  });

  app.openapi(health, async (c) => c.json(await checkHealth(c), 200));
}

async function checkHealth(c: Context<AppEnv>): Promise<HealthResponse> {
  const base = {
    version: c.env.BUILD_ID,
    environment: c.env.ENVIRONMENT,
    time: new Date().toISOString(),
  };
  if (!databaseUrl(c.env)) {
    return { ...base, status: "degraded", database: "unconfigured", migrations: null };
  }
  if (probeCache && Date.now() - probeCache.at < probeTtlMs) {
    return { ...base, ...probeCache.value };
  }
  let value: Pick<HealthResponse, "status" | "database" | "migrations">;
  try {
    const row = await getDb(c)
      .selectFrom("schema_migrations")
      .select(({ fn }) => [fn.countAll<string>().as("applied"), fn.max("name").as("latest")])
      .executeTakeFirst();
    value = {
      status: "ok",
      database: "ok",
      migrations: { applied: Number(row?.applied ?? 0), latest: row?.latest ?? null },
    };
  } catch (err) {
    c.get("log").warn("database health failed", { "error.type": (err as Error).name });
    value = { status: "degraded", database: "error", migrations: null };
  }
  probeCache = { at: Date.now(), value };
  return { ...base, ...value };
}
