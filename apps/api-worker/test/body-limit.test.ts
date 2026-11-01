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

/**
 * A body that declares its length. Neither `app.request` nor `fetch` adds a
 * Content-Length to a string body inside the Workers runtime, so the header
 * is set by hand; without it a case takes the counting path, not the early
 * refusal.
 */
const withLength = (bytes: number) => ({
  body: padded(bytes),
  extra: { "content-length": String(bytes) },
});

/** The cap's own marks on a refusal (invariant 5). */
function expectMarked(got: { headers: Headers }, label: string) {
  expect(got.headers.get("cache-control"), label).toBe("no-store");
  expect(got.headers.get("vary") ?? "", label).toMatch(/(^|,\s*)Origin(,|$)/i);
}

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
    it(`${method} ${path}: 1 MB with a Content-Length answers 413 without reading`, async () => {
      const { body, extra } = withLength(MB);
      const { headers: h, ...got } = await send(method, path, body, extra);
      expect(got).toEqual(refused);
      expectMarked({ headers: h }, path);
    });
    it(`${method} ${path}: 1 MB chunked answers 413`, async () => {
      const { headers: h, ...got } = await send(method, path, chunked(MB));
      expect(got).toEqual(refused);
      expectMarked({ headers: h }, path);
    });
  }

  it("through the real entrypoint, 1 MB with a length or chunked answers 413", async () => {
    const sent: [string, BodyInit, Record<string, string>][] = [
      ["length", padded(MB), { "content-length": String(MB) }],
      ["chunked", chunked(MB), {}],
    ];
    for (const [label, body, extra] of sent) {
      const res = await SELF.fetch("https://api.test/v1/public/quotes", {
        method: "POST",
        headers: { ...headers, ...extra },
        body,
        duplex: "half",
      } as RequestInit);
      const { headers: h, ...got } = await read(res);
      expect(got, label).toEqual(refused);
      expectMarked({ headers: h }, label);
    }
  });

  it("lets exactly 16 KiB reach validation and refuses one byte more, declared or counted", async () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(16_384);
    const at = withLength(16_384);
    const atDeclared = await send("POST", "/v1/public/quotes", at.body, at.extra);
    expect([atDeclared.status, atDeclared.code]).toEqual([400, "validation_failed"]);
    const atChunked = await send("POST", "/v1/public/quotes", chunked(16_384));
    expect([atChunked.status, atChunked.code]).toEqual([400, "validation_failed"]);
    const over = withLength(16_385);
    const overDeclared = await send("POST", "/v1/public/quotes", over.body, over.extra);
    expect([overDeclared.status, overDeclared.code]).toEqual([413, "payload_too_large"]);
    expectMarked(overDeclared, "declared 16,385");
    const overChunked = await send("POST", "/v1/public/quotes", chunked(16_385));
    expect([overChunked.status, overChunked.code]).toEqual([413, "payload_too_large"]);
    expectMarked(overChunked, "chunked 16,385");
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
    // No Origin: the route refuses browsers. An unsigned body is the route's 400.
    const send64 = async (body: BodyInit, extra: Record<string, string> = {}) =>
      read(
        await app.request(
          `https://api.test${path}`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...extra },
            body,
            duplex: "half",
          } as RequestInit,
          fake,
          createExecutionContext(),
        ),
      );
    const at = withLength(65_536);
    const atDeclared = await send64(at.body, at.extra);
    expect([atDeclared.status, atDeclared.code]).toEqual([400, "signature_invalid"]);
    const atChunked = await send64(chunked(65_536));
    expect([atChunked.status, atChunked.code]).toEqual([400, "signature_invalid"]);
    const over = withLength(65_537);
    const overDeclared = await send64(over.body, over.extra);
    expect([overDeclared.status, overDeclared.code]).toEqual([413, "payload_too_large"]);
    const overChunked = await send64(chunked(65_537));
    expect([overChunked.status, overChunked.code]).toEqual([413, "payload_too_large"]);
  });

  it("refuses a declared oversize body without reading a byte of it", async () => {
    let pulls = 0;
    const watched = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          // 16 chunks of 64 KiB, about 1 MB, then the end.
          if (pulls++ < 16) controller.enqueue(new Uint8Array(64 * 1024));
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const got = await send("POST", "/v1/public/quotes", watched, {
      "content-length": String(MB),
    });
    expect([got.status, got.code]).toEqual([413, "payload_too_large"]);
    expectMarked(got, "declared 1 MB stream");
    expect(pulls).toBe(0);
  });

  it("never lets a small declared length admit a large body", async () => {
    const got = await send("POST", "/v1/public/quotes", padded(100_000), {
      "content-length": "10",
    });
    expect([got.status, got.code]).toEqual([413, "payload_too_large"]);
  });

  it("marks every refusal no-store and Vary: Origin, public and staff alike", async () => {
    for (const path of ["/v1/public/quotes", "/v1/staff/tenants/x/members"]) {
      const { body, extra } = withLength(MB);
      const declared = await send("POST", path, body, extra);
      expect(declared.status, path).toBe(413);
      expectMarked(declared, `${path} declared`);
      const streamed = await send("POST", path, chunked(MB));
      expect(streamed.status, path).toBe(413);
      expectMarked(streamed, `${path} chunked`);
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
    // A path with no route: without the cap it would be a 404, and nothing
    // else on it sets no-store or reads the body.
    const res = await app.request(
      "https://api.test/v1/nope",
      { method: "POST", headers, body: broken, duplex: "half" } as RequestInit,
      bindings,
      createExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(json.error).toMatchObject({
      code: "bad_request",
      message: "The request body could not be read",
    });
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
  $ref?: string;
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
type Doc = {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

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

/**
 * Every unbounded array, string, or open map in a request schema. A `$ref` is
 * followed into `components.schemas` (each target once), an unresolvable one
 * is reported, and so is a node that says nothing of its shape.
 */
function unbounded(
  node: Schema,
  at: string,
  out: string[],
  components: Record<string, Schema> = {},
  seen = new Set<string>(),
): string[] {
  let schema = node;
  if (schema.$ref !== undefined) {
    const name = schema.$ref.startsWith("#/components/schemas/")
      ? schema.$ref.slice("#/components/schemas/".length)
      : undefined;
    const target = name === undefined ? undefined : components[name];
    if (!target) {
      out.push(`${at}: unresolved $ref ${schema.$ref}`);
      return out;
    }
    if (seen.has(schema.$ref)) return out;
    seen.add(schema.$ref);
    schema = target;
  }
  const recurse = (child: Schema, where: string) => unbounded(child, where, out, components, seen);
  const branches = [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])];
  for (const branch of branches) recurse(branch, at);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (
    types.length === 0 &&
    branches.length === 0 &&
    schema.enum === undefined &&
    schema.const === undefined
  ) {
    out.push(`${at}: schema without a type`);
  }
  if (types.includes("array")) {
    if (schema.maxItems === undefined) out.push(`${at}: array without maxItems`);
    if (schema.items) recurse(schema.items, `${at}[]`);
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
    recurse(child, `${at}.${key}`);
  if (typeof schema.additionalProperties === "object") {
    if (schema.maxProperties === undefined) out.push(`${at}: open map without maxProperties`);
    recurse(schema.additionalProperties, `${at}{}`);
  }
  return out;
}

describe("the published contract", () => {
  it("declares 413 on every operation with a request body", async () => {
    const withBody = operations(await contract()).filter(({ op }) => op.requestBody);
    expect(withBody.length).toBeGreaterThanOrEqual(23);
    expect(withBody.filter(({ op }) => !op.responses["413"]).map(({ name }) => name)).toEqual([]);
    for (const { name, op } of withBody) {
      const description = op.responses["413"]?.description ?? "";
      expect(description, name).toMatch(/\(payload_too_large\)$/);
      // A guest page calls these cross-origin, and the cap answers before CORS.
      const guestRoute = / \/v1\/(public|fake-provider)\//.test(name);
      expect(/without CORS headers/.test(description), name).toBe(guestRoute);
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
    const doc = await contract();
    const components = doc.components?.schemas ?? {};
    const found: string[] = [];
    for (const { name, op } of operations(doc)) {
      for (const [type, media] of Object.entries(op.requestBody?.content ?? {}))
        unbounded(media.schema, `${name} ${type}`, found, components);
    }
    expect(found).toEqual([]);
    // The scan itself: a reference is followed, a cycle ends, and a node with
    // no shape, an unknown reference, or an open map is reported.
    const refs: Record<string, Schema> = {
      Codes: { type: "array", items: { type: "string", maxLength: 4 } },
      Loop: { type: "object", properties: { next: { $ref: "#/components/schemas/Loop" } } },
    };
    expect(unbounded({ $ref: "#/components/schemas/Codes" }, "r", [], refs)).toEqual([
      "r: array without maxItems",
    ]);
    expect(unbounded({ $ref: "#/components/schemas/Loop" }, "l", [], refs)).toEqual([]);
    expect(unbounded({ $ref: "#/components/schemas/Gone" }, "g", [], refs)).toEqual([
      "g: unresolved $ref #/components/schemas/Gone",
    ]);
    expect(unbounded({}, "u", [])).toEqual(["u: schema without a type"]);
    expect(
      unbounded({ type: "object", additionalProperties: { type: "integer" } }, "m", []),
    ).toEqual(["m: open map without maxProperties"]);
    expect(boundedPattern("^[a-z][a-z0-9_]{0,31}$")).toBe(true);
    expect(boundedPattern("^[a-z]+$")).toBe(false);
    expect(boundedPattern("^a{2,}$")).toBe(false);
    expect(boundedPattern("[a-z]{1,3}")).toBe(false);
    expect(boundedPattern("^[*+]{1,3}\\.$")).toBe(true);
  });
});
