import type { Context } from "hono";
import type { AppEnv } from "../context.ts";

export interface LoginLinkDelivery {
  /** Present only when the link may be shown to the requester (local development). */
  devLink?: string;
}

export interface LoginLinkSender {
  send(input: { c: Context<AppEnv>; email: string; link: string }): Promise<LoginLinkDelivery>;
}

/**
 * Local development: hand the link back to the browser, and only when both the
 * environment is local and the request reached a loopback host. A misconfigured
 * ENVIRONMENT on a deployed Worker therefore still cannot leak a link.
 */
const devLinkSender: LoginLinkSender = {
  async send({ c, link }) {
    const host = new URL(c.req.url).hostname;
    return host === "localhost" || host === "127.0.0.1" ? { devLink: link } : {};
  },
};

/** Deployed environments until transactional email exists (G2.16). */
const undeliverableSender: LoginLinkSender = {
  async send({ c }) {
    c.get("log").warn("login link not delivered: no email adapter configured", {
      "event.name": "login_link_undeliverable",
    });
    return {};
  },
};

export function defaultLoginLinkSender(c: Context<AppEnv>): LoginLinkSender {
  return c.env.ENVIRONMENT === "local" ? devLinkSender : undeliverableSender;
}
