import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { apiVersion, ErrorResponse, HealthResponse } from "@tidegrid/contracts";
import { createDb } from "@tidegrid/database";
import { createLogger, newRequestId } from "@tidegrid/observability";
import type { Context } from "hono";
import { type Bindings, databaseUrl } from "./env.ts";

type Variables = { requestId: string; log: ReturnType<typeof createLogger> };

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "validation_failed",
              message: "Request did not match the contract",
              requestId: c.get("requestId") ?? "unknown",
            },
          },
          400,
        );
      }
    },
  });

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? newRequestId();
    const started = Date.now();
    const url = new URL(c.req.url);
    const log = createLogger({
      "tidegrid.request_id": requestId,
      "tidegrid.environment": c.env.ENVIRONMENT,
      "http.request.method": c.req.method,
      "url.path": url.pathname,
      "server.address": url.hostname,
    });
    c.set("requestId", requestId);
    c.set("log", log);
    c.header("x-request-id", requestId);
    await next();
    log.info("request", {
      "http.response.status_code": c.res.status,
      duration_ms: Date.now() - started,
    });
  });

  app.onError((err, c) => {
    c.get("log")?.error("unhandled", { "error.type": err.name });
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Something went wrong",
          requestId: c.get("requestId") ?? "unknown",
        },
      },
      500,
    );
  });

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
      500: { content: { "application/json": { schema: ErrorResponse } }, description: "Failure" },
    },
  });

  app.openapi(health, async (c) => {
    const body = await checkHealth(c);
    return c.json(body, 200);
  });

  app.doc31("/v1/openapi.json", {
    openapi: "3.1.0",
    info: { title: "TideGrid API", version: "0.0.0" },
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: "No such route",
          requestId: c.get("requestId") ?? "unknown",
        },
      },
      404,
    ),
  );

  return app;
}

async function checkHealth(c: Context<AppEnv>): Promise<HealthResponse> {
  const url = databaseUrl(c.env);
  const base = {
    version: c.env.BUILD_ID,
    environment: c.env.ENVIRONMENT,
    time: new Date().toISOString(),
  };
  if (!url) {
    return { ...base, status: "degraded", database: "unconfigured", migrations: null };
  }
  const { db, end } = createDb(url, { max: 1 });
  try {
    const rows = await db
      .selectFrom("schema_migrations")
      .select(({ fn }) => [fn.countAll<string>().as("applied"), fn.max("name").as("latest")])
      .execute();
    const row = rows[0];
    return {
      ...base,
      status: "ok",
      database: "ok",
      migrations: { applied: Number(row?.applied ?? 0), latest: row?.latest ?? null },
    };
  } catch (err) {
    c.get("log").warn("database health failed", { "error.type": (err as Error).name });
    return { ...base, status: "degraded", database: "error", migrations: null };
  } finally {
    c.executionCtx.waitUntil(end());
  }
}
