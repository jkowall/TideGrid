import type { Context, Next } from "hono";
import type { AppEnv } from "./context.ts";
import type { Bindings } from "./env.ts";
import { ApiError } from "./errors.ts";

/**
 * Staff and sign-in routes answer only through the console gateway: the
 * console Worker's service binding to the `ConsoleGateway` entrypoint, which
 * sits behind Cloudflare Access. Internet traffic reaches the default export
 * instead and cannot carry this mark, because it is a symbol on the environment
 * object, not a header, cookie, or variable anyone can set.
 */
const viaConsole = Symbol("tidegrid.console-gateway");

export function markConsoleGateway(env: Bindings): Bindings {
  return Object.create(env, { [viaConsole]: { value: true } }) as Bindings;
}

export function cameThroughConsoleGateway(env: Bindings): boolean {
  return (env as unknown as Record<symbol, unknown>)[viaConsole] === true;
}

/** Local development only: the Vite proxy reaches `wrangler dev` on a loopback host. */
function isLocalLoopback(c: Context<AppEnv>): boolean {
  if (c.env.ENVIRONMENT !== "local") return false;
  const host = new URL(c.req.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

/** Anywhere else these routes do not exist, so the answer is the ordinary 404. */
export async function requireConsoleGateway(c: Context<AppEnv>, next: Next) {
  if (!cameThroughConsoleGateway(c.env) && !isLocalLoopback(c)) {
    throw new ApiError(404, "not_found", "No such route");
  }
  await next();
}
