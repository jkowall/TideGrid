import type { Context, Next } from "hono";
import type { AppEnv } from "../context.ts";
import { staffOrigins } from "../env.ts";
import { ApiError } from "../errors.ts";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for cookie- and Access-authenticated staff routes: every
 * state-changing request must carry an Origin header naming the console.
 * Browsers always send Origin on cross-origin and same-origin POST; the session
 * cookie is also SameSite=Strict.
 */
export async function requireStaffOrigin(c: Context<AppEnv>, next: Next) {
  if (!safeMethods.has(c.req.method)) {
    const origin = c.req.header("origin");
    if (!origin || !staffOrigins(c.env).includes(origin)) {
      throw new ApiError(403, "origin_not_allowed", "Requests must come from the TideGrid console");
    }
  }
  await next();
}

/** Per-IP limiter for sign-in endpoints; a no-op where the binding is absent. */
export async function limitByIp(c: Context<AppEnv>, bucket: string): Promise<void> {
  const limiter = c.env.AUTH_RATE_LIMITER;
  if (!limiter) return;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${bucket}:${ip}` });
  if (!success) throw new ApiError(429, "rate_limited", "Too many attempts; wait a minute");
}
