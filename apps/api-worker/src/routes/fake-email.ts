import type { OpenAPIHono } from "@hono/zod-openapi";
import { normalizeHostname } from "@tidegrid/domain-identity";
import { escapeHtml, fakeEmailIdPattern } from "@tidegrid/domain-messaging";
import type { Context } from "hono";
import { sql } from "kysely";
import type { AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { emailSettings, fakeEmailProviderFor } from "../email.ts";
import { allowedOrigins } from "../env.ts";

/**
 * The demo mailbox (lane 1, the G2.16 shim): what the fake email provider
 * "sent", so the demo can open a booking's confirmation and its management
 * link without real email. It exists only when EMAIL_PROVIDER=fake and
 * ENVIRONMENT=local; everywhere else these routes answer 404. It is a local
 * development tool, like a mail catcher: anyone who can reach a local API can
 * read every synthetic guest's mail there.
 *
 * Plain HTML pages, outside the API contract, with no script at all: the
 * policy allows inline styles (email is styled inline) and data images, and
 * nothing else. The tenant is the guest site's hostname, resolved like a
 * browser Origin, so the mailbox shows one operator's mail at a time.
 */

const pageCsp =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function enabled(c: Context<AppEnv>): boolean {
  return emailSettings(c.env).kind === "fake" && c.env.ENVIRONMENT === "local";
}

function page(c: Context<AppEnv>, html: string, status: 200 | 404 = 200) {
  c.header("Content-Security-Policy", pageCsp);
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(html, status);
}

const style = {
  body: "margin:0;background:#f6f7f6;color:#0e2b1f;font:16px/1.5 Arial,Helvetica,sans-serif;",
  main: "max-width:880px;margin:0 auto;padding:24px 16px;",
  card: "background:#fff;border:1px solid #e8ece8;border-radius:12px;padding:16px;margin:0 0 12px;",
  link: "color:#0e2b1f;font-weight:700;",
  muted: "color:#3d4a44;font-size:14px;",
};

function shell(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title></head>`,
    `<body style="${style.body}"><main style="${style.main}">`,
    body,
    "</main></body></html>",
  ].join("");
}

async function tenantFor(c: Context<AppEnv>, host: string): Promise<string | null> {
  const normalized = normalizeHostname(`http://${host}`);
  if (!normalized) return null;
  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.resolve_hostname(${normalized})`.execute(getDb(c));
  return rows[0]?.tenant_id ?? null;
}

export function registerFakeEmailRoutes(app: OpenAPIHono<AppEnv>) {
  const notFound = (c: Context<AppEnv>) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: "No such route",
          requestId: c.get("requestId") ?? "unknown",
        },
      },
      404,
    );

  app.get("/v1/fake-email/mailbox", async (c) => {
    if (!enabled(c)) return notFound(c);
    const sites: { host: string; tenantId: string }[] = [];
    for (const origin of allowedOrigins(c.env)) {
      let host: string;
      try {
        host = new URL(origin).hostname;
      } catch {
        continue;
      }
      const tenantId = await tenantFor(c, host);
      if (tenantId) sites.push({ host, tenantId });
    }
    const items = sites.length
      ? sites
          .map(
            (s) =>
              `<li style="margin:0 0 8px;"><a style="${style.link}" href="/v1/fake-email/mailbox/${encodeURIComponent(s.host)}">${escapeHtml(s.host)}</a></li>`,
          )
          .join("")
      : `<li>No allowed guest origin resolves to an operator. Add the guest sites to ALLOWED_ORIGINS and seed with SEED_LOCAL_HOSTNAMES=1.</li>`;
    return page(
      c,
      shell(
        "Demo mailbox",
        `<h1>Demo mailbox</h1><p style="${style.muted}">What the fake email provider sent, for local development only. No real email leaves this machine. Choose a booking site:</p><ul>${items}</ul>`,
      ),
    );
  });

  app.get("/v1/fake-email/mailbox/:host", async (c) => {
    if (!enabled(c)) return notFound(c);
    const host = c.req.param("host");
    const tenantId = await tenantFor(c, host);
    const fake = fakeEmailProviderFor(c);
    if (!tenantId || !fake) {
      return page(c, shell("Not found", "<h1>No operator at that site</h1>"), 404);
    }
    const messages = await fake.listMailbox(tenantId, 50);
    const base = `/v1/fake-email/mailbox/${encodeURIComponent(host)}`;
    const rows = messages.length
      ? messages
          .map(
            (m) =>
              `<li style="${style.card}list-style:none;"><a style="${style.link}" href="${base}/${encodeURIComponent(m.id)}">${escapeHtml(m.subject)}</a><br><span style="${style.muted}">To ${escapeHtml(m.toName ? `${m.toName} <${m.to}>` : m.to)}, from ${escapeHtml(m.fromName)}, ${escapeHtml(new Date(m.createdAt).toUTCString())}</span></li>`,
          )
          .join("")
      : `<li style="${style.card}list-style:none;">Nothing yet. Mail appears here a moment after it is sent; reload this page.</li>`;
    return page(
      c,
      shell(
        `Mailbox: ${host}`,
        `<p><a style="${style.link}" href="/v1/fake-email/mailbox">All sites</a></p><h1>Mailbox for ${escapeHtml(host)}</h1><p style="${style.muted}">Newest first, the last 50. <a style="${style.link}" href="${base}">Reload</a></p><ul style="padding:0;">${rows}</ul>`,
      ),
    );
  });

  app.get("/v1/fake-email/mailbox/:host/:id", async (c) => {
    if (!enabled(c)) return notFound(c);
    const host = c.req.param("host");
    const id = c.req.param("id");
    const tenantId = await tenantFor(c, host);
    const fake = fakeEmailProviderFor(c);
    if (!tenantId || !fake || !fakeEmailIdPattern.test(id)) {
      return page(c, shell("Not found", "<h1>No such message</h1>"), 404);
    }
    const message = await fake.getMailboxMessage(tenantId, id);
    if (!message) return page(c, shell("Not found", "<h1>No such message</h1>"), 404);
    // The email exactly as it was sent: a whole document, styled inline.
    return page(c, message.html);
  });
}
