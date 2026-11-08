import type { Bindings } from "../env.ts";

/**
 * Which sign-in methods this environment accepts for staff.
 *
 * Deployed environments sign staff in through Cloudflare Access only: a
 * Google or Microsoft account, then Cloudflare's own second step (an
 * authenticator app or a security key), which the Access policy requires
 * (owner decision 2026-11-08, "Cloudflare's own second step"). The email
 * link exists for local development, where no Access sits in front of the
 * console. It is decided by ENVIRONMENT alone, so no deployed variable can
 * turn it back on, and a misconfigured ENVIRONMENT still cannot deliver a
 * link (login-links.ts hands a link back only to a loopback host).
 */
export function emailLinkSignInEnabled(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "local";
}
