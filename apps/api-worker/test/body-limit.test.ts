/**
 * The request body cap (proposed hardening): every body the API reads is
 * counted before any parse, CORS lookup, limiter, or database call, and an
 * oversize one answers 413 payload_too_large in the shared error shape.
 *
 * Every cap case goes through `createApp().request` with the test bindings,
 * so none depends on how Miniflare frames a request; one pair also goes
 * through `SELF.fetch` to cover the real entrypoint. No database is bound:
 * everything here is decided before one would be reached.
 */
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import {
  bodyLimitFor,
  capRequestBody,
  declarePayloadTooLarge,
  MAX_REQUEST_BODY_BYTES,
} from "../src/body-limit.ts";
import type { AppEnv } from "../src/context.ts";
import type { Bindings } from "../src/env.ts";

const app = createApp();
const bindings = env as Bindings;
const headers = {
  "content-type": "application/json",
  origin: "https://guest.test",
  "idempotency-key": "abcdefgh1234",
};
const MB = 1_000_000;

/** A JSON object of exactly `bytes` bytes: `{"pad":"xx…"}`. */
const padded = (bytes: number) => JSON.stringify({ pad: "x".repeat(bytes - 10) });

/** The same object as a stream with no Content-Length, in 16 KiB chunks. */
function chunked(bytes: number): ReadableStream<Uint8Array> {
  const whole = new TextEncoder().encode(padded(bytes));
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= whole.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(whole.slice(at, at + 16 * 1024));
      at += 16 * 1024;
    },
  });
}

type Body = { error?: { code?: string; requestId?: string } };

async function send(
  method: string,
  path: string,
  body: BodyInit | null,
  extra: Record<string, string> = {},
  on: Bindings = bindings,
) {
  const res = await app.request(
    `https://api.test${path}`,
    { method, headers: { ...headers, ...extra }, body, duplex: "half" } as RequestInit,
    on,
    createExecutionContext(),
  );
  return read(res);
}

async function read(res: Response) {
  const text = await res.text();
  let json: Body = {};
  try {
    json = JSON.parse(text) as Body;
  } catch {
    json = {};
  }
  return {
    status: res.status,
    code: json.error?.code,
    idMatches:
      json.error?.requestId !== undefined
        ? res.headers.get("x-request-id") === json.error.requestId
        : false,
    headers: res.headers,
  };
}

const refused = { status: 413, code: "payload_too_large", idMatches: true };

describe("request body cap", () => {
  const routes = [
    ["POST", "/v1/public/quotes"],
    ["POST", "/v1/public/checkout-sessions"],
    ["PUT", "/v1/public/manage/participants/1"],
    ["POST", "/v1/public/waiver-sessions/current/signature"],
    ["POST", "/v1/fake-provider/payments/x/succeed"],
    ["POST", "/v1/staff/tenants/x/members"],
    ["POST", "/v1/nope"],
  ] as const;

  for (const [method, path] of routes) {
    it(`${method} ${path}: 1 MB with a Content-Length answers 413`, async () => {
      const { headers: _h, ...got } = await send(method, path, padded(MB));
      expect(got).toEqual(refused);
    });
    it(`${method} ${path}: 1 MB chunked answers 413`, async () => {
      const { headers: _h, ...got } = await send(method, path, chunked(MB));
      expect(got).toEqual(refused);
    });
  }

  it("through the real entrypoint, 1 MB with a length or chunked answers 413", async () => {
    for (const body of [padded(MB), chunked(MB)]) {
      const res = await SELF.fetch("https://api.test/v1/public/quotes", {
        method: "POST",
        headers,
        body,
        duplex: "half",
      } as RequestInit);
      const { headers: _h, ...got } = await read(res);
      expect(got).toEqual(refused);
    }
  });

  it("lets exactly 16 KiB reach validation and refuses one byte more", async () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(16_384);
    const at = await send("POST", "/v1/public/quotes", padded(16_384));
    expect([at.status, at.code]).toEqual([400, "validation_failed"]);
    const over = await send("POST", "/v1/public/quotes", padded(16_385));
    expect([over.status, over.code]).toEqual([413, "payload_too_large"]);
    const overChunked = await send("POST", "/v1/public/quotes", chunked(16_385));
    expect([overChunked.status, overChunked.code]).toEqual([413, "payload_too_large"]);
  });

  it("keeps the webhook's 64 KiB: 65,536 bytes pass the cap, 65,537 do not", async () => {
    const fake: Bindings = {
      ...bindings,
      PAYMENT_PROVIDER: "fake",
      FAKE_PAYMENT_WEBHOOK_SECRET: "workers-test-fake-provider-secret-0123456789",
    };
    const path = "/v1/webhooks/payments/fake";
    expect(bodyLimitFor(path)).toBe(65_536);
    expect(bodyLimitFor("/v1/webhooks/other")).toBe(16_384);
    const plain = { "content-type": "application/json" };
    // No Origin: the route refuses browsers. An unsigned body is the route's 400.
    const send64 = async (body: BodyInit) =>
      read(
        await app.request(
          `https://api.test${path}`,
          { method: "POST", headers: plain, body, duplex: "half" } as RequestInit,
          fake,
          createExecutionContext(),
        ),
      );
    const at = await send64(padded(65_536));
    expect([at.status, at.code]).toEqual([400, "signature_invalid"]);
    const atChunked = await send64(chunked(65_536));
    expect([atChunked.status, atChunked.code]).toEqual([400, "signature_invalid"]);
    const over = await send64(chunked(65_537));
    expect([over.status, over.code]).toEqual([413, "payload_too_large"]);
  });

  it("never lets a small declared length admit a large body", async () => {
    const got = await send("POST", "/v1/public/quotes", padded(100_000), {
      "content-length": "10",
    });
    expect([got.status, got.code]).toEqual([413, "payload_too_large"]);
  });

  it("marks every refusal no-store and Vary: Origin, public and staff alike", async () => {
    for (const path of ["/v1/public/quotes", "/v1/staff/tenants/x/members"]) {
      for (const body of [padded(MB), chunked(MB)]) {
        const got = await send("POST", path, body);
        expect(got.status, path).toBe(413);
        expect(got.headers.get("cache-control"), path).toBe("no-store");
        expect(got.headers.get("vary") ?? "", path).toMatch(/(^|,\s*)Origin(,|$)/i);
      }
    }
  });

  it("answers a body the client abandons mid-stream with 400 bad_request", async () => {
    let sent = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ === 0) controller.enqueue(new TextEncoder().encode('{"pad":"'));
        else controller.error(new Error("client went away"));
      },
    });
    const got = await send("POST", "/v1/public/quotes", broken);
    expect([got.status, got.code]).toEqual([400, "bad_request"]);
  });
});

describe("what the cap hands on", () => {
  function echo() {
    const mini = new Hono<AppEnv>();
    mini.use("*", capRequestBody);
    mini.post("*", async (c) =>
      c.json({ length: c.req.header("content-length") ?? null, body: await c.req.text() }),
    );
    return mini;
  }
  // Multi-byte characters, so bytes and characters differ.
  const text = JSON.stringify({ note: "Tide ≈ 2 m; café crew 🐠", n: 1 }).repeat(10);
  const bytes = new TextEncoder().encode(text).byteLength;

  it("sets Content-Length to the counted bytes and passes them unchanged", async () => {
    const mini = echo();
    const declared = await mini.request(
      "https://api.test/x",
      { method: "POST", headers: { "content-length": "10" }, body: text },
      bindings,
    );
    expect(await declared.json()).toEqual({ length: String(bytes), body: text });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const all = new TextEncoder().encode(text);
        controller.enqueue(all.slice(0, 7));
        controller.enqueue(all.slice(7));
        controller.close();
      },
    });
    const streamed = await mini.request(
      "https://api.test/x",
      { method: "POST", body: stream, duplex: "half" } as RequestInit,
      bindings,
    );
    expect(await streamed.json()).toEqual({ length: String(bytes), body: text });
  });

  it("leaves GET and HEAD untouched, even with a body", async () => {
    for (const method of ["GET", "HEAD"]) {
      // The Fetch API cannot build a GET or HEAD with a body, so a stub stands in.
      const raw = {
        method,
        url: "https://api.test/v1/public/quotes",
        headers: new Headers({ "content-length": "999999" }),
        body: new ReadableStream(),
      } as unknown as Request;
      const c = {
        req: { raw, method, path: "/v1/public/quotes", header: () => undefined },
        header: vi.fn(),
        get: () => undefined,
      };
      const next = vi.fn(async () => {});
      await capRequestBody(c as never, next);
      expect(next).toHaveBeenCalledOnce();
      expect(c.req.raw).toBe(raw);
      expect(c.header).not.toHaveBeenCalled();
    }
  });

  it("leaves a preflight as it was", async () => {
    const res = await app.request(
      "https://api.test/v1/public/quotes",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://guest.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,idempotency-key",
        },
      },
      bindings,
      createExecutionContext(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://guest.test");
  });
});

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  maxItems?: number;
  maxLength?: number;
  maxProperties?: number;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  format?: string;
};
type Operation = {
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { description?: string }>;
};
type Doc = { paths: Record<string, Record<string, Operation>> };

async function contract(): Promise<Doc> {
  const res = await app.request("https://api.test/v1/openapi.json", {}, bindings);
  return (await res.json()) as Doc;
}

function operations(doc: Doc) {
  return Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => ({ name: `${method.toUpperCase()} ${path}`, op })),
  );
}

/**
 * A pattern bounds a string when it is anchored at both ends and every
 * quantifier is bounded: no `*`, no `+`, no open `{n,}`. Escaped characters and
 * character classes are skipped, so a literal `\*` or `[*+]` does not count.
 */
function boundedPattern(pattern: string): boolean {
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.endsWith("\\$")) return false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "*" || ch === "+") return false;
    else if (ch === "{" && /^\{\d+,\}/.test(pattern.slice(i))) return false;
  }
  return true;
}

/** Every unbounded array, string, or open map in a request schema. */
function unbounded(schema: Schema, at: string, out: string[]): string[] {
  for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])])
    unbounded(branch, at, out);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("array")) {
    if (schema.maxItems === undefined) out.push(`${at}: array without maxItems`);
    if (schema.items) unbounded(schema.items, `${at}[]`, out);
  }
  if (types.includes("string")) {
    const bounded =
      schema.maxLength !== undefined ||
      schema.enum !== undefined ||
      schema.const !== undefined ||
      (schema.pattern !== undefined && boundedPattern(schema.pattern)) ||
      schema.format === "uuid" ||
      schema.format === "date";
    if (!bounded) out.push(`${at}: string without a bound`);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    unbounded(child, `${at}.${key}`, out);
  if (typeof schema.additionalProperties === "object") {
    if (schema.maxProperties === undefined) out.push(`${at}: open map without maxProperties`);
    unbounded(schema.additionalProperties, `${at}{}`, out);
  }
  return out;
}

describe("the published contract", () => {
  it("declares 413 on every operation with a request body", async () => {
    const withBody = operations(await contract()).filter(({ op }) => op.requestBody);
    expect(withBody.length).toBeGreaterThanOrEqual(23);
    expect(withBody.filter(({ op }) => !op.responses["413"]).map(({ name }) => name)).toEqual([]);
    for (const { op } of withBody) {
      expect(op.responses["413"]?.description).toMatch(/\(payload_too_large\)$/);
    }
  });

  it("keeps the webhook's own 413", async () => {
    const doc = await contract();
    expect(doc.paths["/v1/webhooks/payments/{provider}"]?.post?.responses["413"]?.description).toBe(
      "The body is larger than any provider event (payload_too_large)",
    );
  });

  it("adds a 413 once, to request bodies only", () => {
    const route = (body: boolean, responses: Record<string, unknown>) => ({
      type: "route" as const,
      route: { path: "/v1/x", ...(body ? { request: { body: {} } } : {}), responses },
    });
    const own = { description: "own" };
    const defs = [route(true, {}), route(false, {}), route(true, { 413: own })];
    declarePayloadTooLarge({ openAPIRegistry: { definitions: defs } } as never);
    expect(Object.keys(defs[0]?.route.responses ?? {})).toEqual(["413"]);
    expect(defs[1]?.route.responses).toEqual({});
    expect(defs[2]?.route.responses).toEqual({ 413: own });
  });

  it("bounds every request array, string, and map (by rule, not by luck)", async () => {
    const found: string[] = [];
    for (const { name, op } of operations(await contract())) {
      for (const [type, media] of Object.entries(op.requestBody?.content ?? {}))
        unbounded(media.schema, `${name} ${type}`, found);
    }
    expect(found).toEqual([]);
    expect(boundedPattern("^[a-z][a-z0-9_]{0,31}$")).toBe(true);
    expect(boundedPattern("^[a-z]+$")).toBe(false);
    expect(boundedPattern("^a{2,}$")).toBe(false);
    expect(boundedPattern("[a-z]{1,3}")).toBe(false);
    expect(boundedPattern("^[*+]{1,3}\\.$")).toBe(true);
  });
});
