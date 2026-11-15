import type { Context } from "hono";
import type { AppDeps, AppEnv } from "./context.ts";
import { ApiError } from "./errors.ts";

/**
 * Cloudflare Turnstile on the public writes a script could abuse without any
 * secret in hand (W3-OPS-4): opening a checkout (it holds seats), asking for a
 * new waiver link (it sends email), and the dock's booking code lookup (it
 * guesses at bookings). The guest site runs the widget and sends its token in
 * the `Turnstile-Token` header; the API checks it with Cloudflare's siteverify
 * before any database work.
 *
 * - With `TURNSTILE_SECRET_KEY`, every such request needs a token Cloudflare
 *   confirms, for this action, issued on the host the request came from.
 *   Missing: 403 `human_check_required`. Refused: 403 `human_check_failed`.
 *   Cloudflare unreachable: 503 `human_check_unavailable` (fails closed).
 * - Without it, staging and production answer 503 `human_check_unavailable`;
 *   local and preview skip the check (synthetic data, and the native demo app
 *   has no widget).
 *
 * A token works once. A retry, an idempotent one included, needs a new token.
 */
export type HumanCheckAction = "checkout" | "waiver_renewal" | "dock_lookup";

export const TURNSTILE_HEADER = "turnstile-token";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5_000;

/** What siteverify answers, as far as this check reads it. */
export interface SiteverifyResult {
  success: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
}

export type Siteverify = (form: {
  secret: string;
  response: string;
  remoteip: string | null;
}) => Promise<SiteverifyResult>;

export const cloudflareSiteverify: Siteverify = async ({ secret, response, remoteip }) => {
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", response);
  if (remoteip) body.set("remoteip", remoteip);
  const res = await fetch(SITEVERIFY, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`siteverify answered ${res.status}`);
  return (await res.json()) as SiteverifyResult;
};

const unavailable = () =>
  new ApiError(
    503,
    "human_check_unavailable",
    "We could not check this request right now; nothing was done. Try again shortly.",
  );

function originHost(c: Context<AppEnv>): string | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

export async function requireHuman(
  c: Context<AppEnv>,
  deps: AppDeps,
  action: HumanCheckAction,
): Promise<void> {
  const secret = c.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (c.env.ENVIRONMENT === "staging" || c.env.ENVIRONMENT === "production") throw unavailable();
    return;
  }
  const token = c.req.header(TURNSTILE_HEADER);
  if (!token || token.length > 2048) {
    throw new ApiError(403, "human_check_required", "Complete the check on the page first");
  }
  let result: SiteverifyResult;
  try {
    result = await (deps.siteverify ?? cloudflareSiteverify)({
      secret,
      response: token,
      remoteip: c.req.header("cf-connecting-ip") ?? null,
    });
  } catch {
    c.get("log").warn("human_check_unavailable", { action });
    throw unavailable();
  }
  const host = originHost(c);
  if (!result.success || result.action !== action || !host || result.hostname !== host) {
    throw new ApiError(
      403,
      "human_check_failed",
      "The check on the page did not pass; try it again",
    );
  }
}
