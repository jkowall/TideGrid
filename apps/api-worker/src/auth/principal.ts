import { OpaqueToken, type Principal } from "@tidegrid/contracts";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { sql } from "kysely";
import type { AppDeps, AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { ApiError } from "../errors.ts";
import { accessVerifierFromEnv } from "./access.ts";
import { sha256Hex } from "./tokens.ts";

/** `__Host-tg_session`: Secure, Path=/, no Domain, HttpOnly, SameSite=Strict. */
export const SESSION_COOKIE = "tg_session";
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Authenticate a staff request. A Cloudflare Access assertion wins when
 * present; otherwise the magic-link session cookie. Both resolve to the same
 * principal shape. Authentication carries no tenant authority: each tenant
 * route checks membership and role separately.
 */
export async function requirePrincipal(c: Context<AppEnv>, deps: AppDeps): Promise<Principal> {
  const cached = c.get("principal");
  if (cached) return cached;

  // Decide the credential before touching the database, so anonymous traffic
  // costs no connection.
  const assertion = c.req.header("cf-access-jwt-assertion");
  if (assertion) {
    const verifier = deps.accessVerifier ?? accessVerifierFromEnv(c.env);
    if (!verifier) {
      throw new ApiError(401, "access_not_configured", "Cloudflare Access is not configured here");
    }
    let email: string;
    try {
      ({ email } = await verifier.verify(assertion));
    } catch {
      throw new ApiError(
        401,
        "invalid_access_token",
        "The Cloudflare Access assertion is not valid",
      );
    }
    const { rows } = await sql<{ user_id: string; email: string; display_name: string }>`
      select * from app.auth_find_staff_by_email(${email})
    `.execute(getDb(c));
    const row = rows[0];
    if (!row) {
      c.get("log").warn("access identity has no staff account", {
        "event.name": "access_identity_not_provisioned",
      });
      throw new ApiError(403, "not_provisioned", `${email} has no TideGrid console access`);
    }
    return remember(c, {
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      authMethod: "access",
    });
  }

  const token = getCookie(c, SESSION_COOKIE, "host");
  if (!token) throw new ApiError(401, "unauthenticated", "Sign in to continue");
  if (!OpaqueToken.safeParse(token).success) {
    throw new ApiError(401, "session_invalid", "Your session has ended; sign in again");
  }
  const { rows } = await sql<{ user_id: string; email: string; display_name: string }>`
    select * from app.auth_resolve_session(${await sha256Hex(token)})
  `.execute(getDb(c));
  const row = rows[0];
  if (!row) throw new ApiError(401, "session_invalid", "Your session has ended; sign in again");
  return remember(c, {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    authMethod: "magic_link",
  });
}

function remember(c: Context<AppEnv>, principal: Principal): Principal {
  c.set("principal", principal);
  c.get("log").debug("authenticated", { "user.id": principal.userId });
  return principal;
}
