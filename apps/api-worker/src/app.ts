import { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger, newRequestId } from "@tidegrid/observability";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requireStaffOrigin } from "./auth/guards.ts";
import type { AppDeps, AppEnv } from "./context.ts";
import { releaseDb } from "./db.ts";
import { allowedOrigins } from "./env.ts";
import { ApiError } from "./errors.ts";
import { requireConsoleGateway } from "./gateway.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerPublicRoutes } from "./routes/public.ts";
import { registerStaffRoutes } from "./routes/staff.ts";
import { registerSystemRoutes } from "./routes/system.ts";

export type { AppDeps, AppEnv } from "./context.ts";

export function createApp(deps: AppDeps = {}) {
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
    // Always server-issued: the id is written into audit rows, so a client must
    // not be able to choose it.
    const requestId = newRequestId();
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
    try {
      await next();
    } finally {
      releaseDb(c);
    }
    log.info("request", {
      "http.response.status_code": c.res.status,
      "user.id": c.get("principal")?.userId,
      duration_ms: Date.now() - started,
    });
  });

  // Browser origins are an explicit allowlist. G2.14 adds verified tenant
  // hostnames; until then only configured origins may call from a browser.
  app.use("*", async (c, next) => {
    const origins = allowedOrigins(c.env);
    return cors({
      origin: (origin) => (origins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Idempotency-Key", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id", "Idempotent-Replayed"],
      maxAge: 600,
    })(c, next);
  });

  app.use("/v1/auth/*", requireConsoleGateway, requireStaffOrigin);
  app.use("/v1/staff/*", requireConsoleGateway, requireStaffOrigin);
  app.use("/v1/me", requireConsoleGateway);

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "unknown";
    if (err instanceof ApiError) {
      if (err.status >= 500) c.get("log")?.error(err.code, { "error.type": err.name });
      return c.json({ error: { code: err.code, message: err.message, requestId } }, err.status);
    }
    if (err instanceof HTTPException && err.status < 500) {
      return c.json(
        { error: { code: "bad_request", message: err.message || "Bad request", requestId } },
        err.status,
      );
    }
    c.get("log")?.error("unhandled", { "error.type": err.name });
    return c.json(
      { error: { code: "internal_error", message: "Something went wrong", requestId } },
      500,
    );
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "accessJwt", {
    type: "apiKey",
    in: "header",
    name: "Cf-Access-Jwt-Assertion",
    description: "Cloudflare Access application token, injected by Access in front of the console",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: "__Host-tg_session",
    description: "Magic-link session; HttpOnly, Secure, SameSite=Strict",
  });

  registerSystemRoutes(app);
  registerPublicRoutes(app);
  registerAuthRoutes(app, deps);
  registerStaffRoutes(app, deps);

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
