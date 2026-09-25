import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  LoginLinkRequest,
  LoginLinkResponse,
  MeResponse,
  OpaqueToken,
  SessionCreateRequest,
  SessionResponse,
  type StaffRole,
} from "@tidegrid/contracts";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sql } from "kysely";
import { limitByIp } from "../auth/guards.ts";
import { defaultLoginLinkSender } from "../auth/login-links.ts";
import { requirePrincipal, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../auth/principal.ts";
import { newOpaqueToken, sha256Hex } from "../auth/tokens.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { errorBody, staffSecurity } from "./responses.ts";

const LOGIN_TOKEN_TTL_SECONDS = 15 * 60;

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const requestLink = createRoute({
    method: "post",
    path: "/v1/auth/login-links",
    tags: ["auth"],
    summary: "Send a single-use sign-in link",
    description:
      "Answers 202 for every address. The link carries its token in the URL fragment, so it never reaches server logs.",
    request: {
      body: { required: true, content: { "application/json": { schema: LoginLinkRequest } } },
    },
    responses: {
      202: {
        content: { "application/json": { schema: LoginLinkResponse } },
        description: "Accepted",
      },
      400: errorBody("Invalid request"),
      403: errorBody("Origin not allowed"),
      429: errorBody("Too many attempts"),
    },
  });

  app.openapi(requestLink, async (c) => {
    await limitByIp(c, "login-links");
    const { email } = c.req.valid("json");
    const normalized = email.trim().toLowerCase();
    // requireStaffOrigin has already confirmed this header names the console.
    const origin = c.req.header("origin") ?? "";
    const token = newOpaqueToken();
    const { rows } = await sql<{ outcome: string }>`
      select app.auth_issue_login_token(
        ${normalized}, ${await sha256Hex(token)}, ${LOGIN_TOKEN_TTL_SECONDS}, ${c.get("requestId")}
      ) as outcome
    `.execute(getDb(c));
    let devLink: string | undefined;
    if (rows[0]?.outcome === "issued") {
      const sender = deps.loginLinkSender ?? defaultLoginLinkSender(c);
      ({ devLink } = await sender.send({
        c,
        email: normalized,
        link: `${origin}/login#token=${token}`,
      }));
    }
    return c.json(
      devLink ? { status: "accepted" as const, devLink } : { status: "accepted" as const },
      202,
    );
  });

  const createSession = createRoute({
    method: "post",
    path: "/v1/auth/sessions",
    tags: ["auth"],
    summary: "Exchange a sign-in token for a session cookie",
    request: {
      body: { required: true, content: { "application/json": { schema: SessionCreateRequest } } },
    },
    responses: {
      201: {
        content: { "application/json": { schema: SessionResponse } },
        description: "Signed in; sets the __Host-tg_session cookie",
      },
      400: errorBody("Invalid request"),
      401: errorBody("Token invalid, used, or expired"),
      403: errorBody("Origin not allowed"),
      429: errorBody("Too many attempts"),
    },
  });

  app.openapi(createSession, async (c) => {
    await limitByIp(c, "sessions");
    const { token } = c.req.valid("json");
    const sessionToken = newOpaqueToken();
    const sessionHash = await sha256Hex(sessionToken);
    const db = getDb(c);
    const consumed = await sql<{ user_id: string }>`
      select user_id from app.auth_consume_login_token(
        ${await sha256Hex(token)}, ${sessionHash}, ${SESSION_TTL_SECONDS}, ${c.get("requestId")}
      )
    `.execute(db);
    if (!consumed.rows[0]) {
      throw new ApiError(
        401,
        "invalid_or_expired_token",
        "That sign-in link is invalid, already used, or expired",
      );
    }
    const { rows } = await sql<{
      user_id: string;
      email: string;
      display_name: string;
      expires_at: Date;
    }>`select * from app.auth_resolve_session(${sessionHash})`.execute(db);
    const row = rows[0];
    if (!row) throw new ApiError(401, "session_invalid", "The new session could not be opened");
    setCookie(c, SESSION_COOKIE, sessionToken, {
      prefix: "host",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.json(
      {
        principal: {
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          authMethod: "magic_link" as const,
        },
        expiresAt: row.expires_at.toISOString(),
      },
      201,
    );
  });

  const endSession = createRoute({
    method: "delete",
    path: "/v1/auth/sessions/current",
    tags: ["auth"],
    summary: "Sign out of the magic-link session",
    responses: {
      204: { description: "Signed out; the cookie is cleared" },
      403: errorBody("Origin not allowed"),
    },
  });

  app.openapi(endSession, async (c) => {
    const token = getCookie(c, SESSION_COOKIE, "host");
    if (token && OpaqueToken.safeParse(token).success) {
      await sql`select app.auth_revoke_session(${await sha256Hex(token)}, ${c.get("requestId")})`.execute(
        getDb(c),
      );
    }
    deleteCookie(c, SESSION_COOKIE, { prefix: "host", path: "/", secure: true });
    return c.body(null, 204);
  });

  const me = createRoute({
    method: "get",
    path: "/v1/me",
    tags: ["auth"],
    summary: "The signed-in staff identity and its tenant memberships",
    security: staffSecurity,
    responses: {
      200: { content: { "application/json": { schema: MeResponse } }, description: "Signed in" },
      401: errorBody("Not signed in"),
      403: errorBody("Signed in through Access but not provisioned"),
    },
  });

  app.openapi(me, async (c) => {
    const principal = await requirePrincipal(c, deps);
    const { rows } = await sql<{
      tenant_id: string;
      tenant_slug: string;
      tenant_name: string;
      role: StaffRole;
    }>`select * from app.auth_list_memberships(${principal.userId})`.execute(getDb(c));
    return c.json(
      {
        principal,
        memberships: rows.map((r) => ({
          tenantId: r.tenant_id,
          tenantSlug: r.tenant_slug,
          tenantName: r.tenant_name,
          role: r.role,
        })),
      },
      200,
    );
  });
}
