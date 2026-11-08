import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";
import { ApiError } from "./errors.ts";
import {
  MAX_WEBHOOK_BYTES,
  refuseUnlistedStripeSource,
  STRIPE_WEBHOOK_PATH,
} from "./routes/payment-webhooks.ts";
import { errorBody } from "./routes/responses.ts";

/**
 * The most bytes any request body may carry (proposed hardening, coordinator
 * default D1). The largest legitimate body, a quote at every array maximum, is
 * about 4.4 KB. Schema bounds are not byte bounds: JSON whitespace, unknown
 * keys, and padding a `.trim()` removes all cost parse time and memory.
 */
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

const webhookPrefix = "/v1/webhooks/payments/";

/** The routes a guest page calls cross-origin, as in src/hostnames/cors.ts. */
const guestRoutePrefixes = ["/v1/public/", "/v1/fake-provider/"] as const;

/**
 * The one place a per-route limit lives. Payment provider events keep their
 * 64 KiB; every other path, documented or not, gets the default. A route that
 * needs more (an upload, an import) adds its prefix here.
 */
export function bodyLimitFor(path: string): number {
  return path.startsWith(webhookPrefix) ? MAX_WEBHOOK_BYTES : MAX_REQUEST_BODY_BYTES;
}

/**
 * The cap's own answers carry what the CORS and no-store middleware would
 * have added: both are registered after it and never run when it refuses.
 */
function markRefusal(c: Context<AppEnv>): void {
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Origin", { append: true });
}

function tooLarge(c: Context<AppEnv>): ApiError {
  markRefusal(c);
  c.get("log")?.warn("request_body_too_large", {
    "event.name": "request_body_too_large",
    "error.type": "payload_too_large",
  });
  return new ApiError(
    413,
    "payload_too_large",
    "The request body is larger than this route accepts",
  );
}

/**
 * Counts every request body before anything else reads it: before CORS, the
 * limiters, validation, the route, or a database. Mounted on every path.
 *
 * - GET and HEAD pass untouched: no handler reads their body, and the Fetch
 *   API cannot rebuild such a request with one.
 * - A declared Content-Length over the limit is refused without reading. A
 *   declared length never admits a body: the runtime does not hold the body
 *   to it, so the bytes are always counted.
 * - The counted bytes go on as a new request whose Content-Length is the
 *   count, so no later code sees the client's value. The bytes themselves are
 *   unchanged, which a signed webhook relies on.
 *
 * Memory is bounded by the limit: the chunks kept plus one joined copy, and
 * the one chunk that crosses the limit, whose size the caller chose.
 */
export async function capRequestBody(c: Context<AppEnv>, next: Next): Promise<void> {
  const raw = c.req.raw;
  if (raw.method === "GET" || raw.method === "HEAD") return next();
  const body = raw.body;
  if (!body) return next();

  // Under the Stripe provider, an unlisted sender is refused before a byte is
  // read or a size is judged (W1-STRIPE-WEBHOOK). A browser's request is left
  // to the route, which answers origin_not_allowed first.
  if (
    c.req.path === STRIPE_WEBHOOK_PATH &&
    c.env.PAYMENT_PROVIDER === "stripe" &&
    raw.headers.get("origin") === null
  ) {
    try {
      refuseUnlistedStripeSource(c);
    } catch (refusal) {
      body.cancel().catch(() => undefined);
      markRefusal(c);
      throw refusal;
    }
  }

  const limit = bodyLimitFor(c.req.path);
  const declared = raw.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    // Nothing will read it; tell the runtime to stop receiving it.
    body.cancel().catch(() => undefined);
    throw tooLarge(c);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch {
      // The client went away or sent a broken body: its fault, not a 500.
      markRefusal(c);
      throw new HTTPException(400, { message: "The request body could not be read" });
    }
    if (read.done) break;
    size += read.value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => undefined);
      throw tooLarge(c);
    }
    chunks.push(read.value);
  }

  const bytes = chunks.length === 1 && chunks[0] ? chunks[0] : join(chunks, size);
  const headers = new Headers(raw.headers);
  headers.set("content-length", String(size));
  // The body is no longer chunked; only its counted length describes it.
  headers.delete("transfer-encoding");
  c.req.raw = new Request(raw, { body: bytes, headers });
  await next();
}

function join(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * Declares the cap's 413 on every operation with a request body that does not
 * declare its own (the webhook does). Call once, after every route is
 * registered and before the document is served or generated.
 */
export function declarePayloadTooLarge(app: OpenAPIHono<AppEnv>): void {
  for (const def of app.openAPIRegistry.definitions) {
    if (def.type !== "route" || !def.route.request?.body) continue;
    if (def.route.responses[413]) continue;
    const path = def.route.path;
    const kib = bodyLimitFor(path) / 1024;
    // A guest page calls these cross-origin, and the cap answers before CORS.
    const guestRoute = guestRoutePrefixes.some((prefix) => path.startsWith(prefix));
    const browsers = guestRoute
      ? "; a cross-origin browser gets this answer without CORS headers, so it cannot read it"
      : "";
    def.route.responses = {
      ...def.route.responses,
      413: errorBody(
        `The request body is larger than this route accepts, ${kib} KiB${browsers} (payload_too_large)`,
      ),
    };
  }
}
