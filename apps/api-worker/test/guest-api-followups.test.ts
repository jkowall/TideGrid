import { SELF } from "cloudflare:test";
import { ProblemResponse } from "@tidegrid/contracts";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/context.ts";
import { ApiError } from "../src/errors.ts";
import { quoteRejected } from "../src/routes/pricing-public.ts";
import { ProblemError, problemFor } from "../src/routes/problems.ts";

// The guest API follow-ups (W1-GUEST-API) in the Workers runtime, with no
// database: the published contract, and what is decided before a database.

const context = { get: (key: string) => (key === "requestId" ? "req_unit" : undefined) };
const c = context as unknown as Context<AppEnv>;

interface Operation {
  parameters?: { in: string; name: string }[];
  security?: Record<string, unknown>[];
  responses: Record<string, { content?: Record<string, { schema: { $ref?: string } }> }>;
}
type Doc = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { properties: Record<string, unknown> }> };
};

async function openapi(): Promise<Doc> {
  return (await (await SELF.fetch("https://api.test/v1/openapi.json")).json()) as Doc;
}

const ref = (op: Operation | undefined, status: string) =>
  op?.responses[status]?.content?.["application/json"]?.schema.$ref;

describe("problem details (D1)", () => {
  it("lists one problem shape for the 409 and 422 of both guest commands", async () => {
    const doc = await openapi();
    const shape = "#/components/schemas/ProblemResponse";
    for (const path of ["/v1/public/quotes", "/v1/public/checkout-sessions"]) {
      const post = doc.paths[path]?.post;
      expect({ path, conflict: ref(post, "409"), invalid: ref(post, "422") }).toEqual({
        path,
        conflict: shape,
        invalid: shape,
      });
    }
    const properties = Object.keys(doc.components.schemas.ProblemResponse?.properties ?? {});
    expect(properties.sort()).toEqual(
      ["code", "detail", "error", "problems", "remaining", "status", "title", "type"].sort(),
    );
  });

  it("keeps the envelope and adds the RFC 9457 members and every problem", () => {
    const body = problemFor(
      c,
      quoteRejected([
        { code: "unknown_ticket_type", subject: "senior" },
        { code: "promotion_not_applicable", reason: "expired" },
      ]),
    );
    expect(body).toEqual({
      error: {
        code: "unknown_ticket_type",
        message:
          "This quote cannot be priced: unknown_ticket_type (senior), promotion_not_applicable",
        requestId: "req_unit",
      },
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "This quote cannot be priced: unknown_ticket_type (senior), promotion_not_applicable",
      code: "unknown_ticket_type",
      problems: [
        { code: "unknown_ticket_type", subject: "senior" },
        { code: "promotion_not_applicable", subject: null },
      ],
    });
    // The promotion's reason is never sent, so codes cannot be probed.
    expect(JSON.stringify(body)).not.toContain("expired");
    expect(ProblemResponse.safeParse(body).success).toBe(true);
  });

  it("renders a plain 409 or 422 as one problem, and leaves other statuses alone", () => {
    expect(problemFor(c, new ApiError(422, "idempotency_key_reused", "Reused"))?.problems).toEqual([
      { code: "idempotency_key_reused", subject: null },
    ]);
    expect(problemFor(c, new ApiError(409, "trip_not_bookable", "Not on sale"))?.title).toBe(
      "Conflict",
    );
    expect(problemFor(c, new ApiError(404, "quote_not_found", "No such quote"))).toBeNull();
    expect(problemFor(c, new ApiError(429, "rate_limited", "Wait"))).toBeNull();
    expect(problemFor(c, new Error("boom"))).toBeNull();
  });
});

describe("remaining capacity (D2)", () => {
  it("is a count on insufficient_capacity only", () => {
    const short = problemFor(c, quoteRejected([{ code: "insufficient_capacity" }], 3));
    expect(short).toMatchObject({ status: 409, code: "insufficient_capacity", remaining: 3 });
    // Listed behind another problem, the count still comes with it.
    const behind = problemFor(
      c,
      quoteRejected(
        [{ code: "unknown_add_on", subject: "kayak" }, { code: "insufficient_capacity" }],
        0,
      ),
    );
    expect(behind).toMatchObject({ status: 422, code: "unknown_add_on", remaining: 0 });
    // No capacity problem, no count, even when the caller knows one.
    const other = problemFor(c, quoteRejected([{ code: "party_size_out_of_range" }], 7));
    expect(other && "remaining" in other).toBe(false);
    const checkout = problemFor(
      c,
      new ProblemError(
        409,
        "insufficient_capacity",
        "Only 2 seat(s) are left on this trip",
        [{ code: "insufficient_capacity", subject: null }],
        2,
      ),
    );
    expect(checkout?.remaining).toBe(2);
    expect(ProblemResponse.safeParse(checkout).success).toBe(true);
  });
});

describe("the checkout's Bearer reads", () => {
  const id = "5d0c4a1e-2b3c-4d5e-8f60-000000000001";

  it("documents the payment and offer reads with the checkout secret and no query", async () => {
    const doc = await openapi();
    for (const path of [
      "/v1/public/checkout-sessions/{checkoutSessionId}/payment",
      "/v1/public/checkout-sessions/{checkoutSessionId}/offer",
    ]) {
      const get = doc.paths[path]?.get;
      expect({ path, security: get?.security }).toEqual({
        path,
        security: [{ checkoutSecret: [] }],
      });
      // The secret is never a URL parameter.
      expect((get?.parameters ?? []).filter((p) => p.in !== "path")).toEqual([]);
    }
  });

  it("refuses a missing, malformed, or URL-borne secret before any database", async () => {
    const secret = "A".repeat(43);
    for (const suffix of ["payment", "offer"]) {
      const base = `https://api.test/v1/public/checkout-sessions/${id}/${suffix}`;
      for (const [url, headers] of [
        [base, {}],
        [base, { authorization: "Bearer short" }],
        [`${base}?secret=${secret}`, {}],
        [`${base}?access_token=${secret}`, {}],
      ] as const) {
        const res = await SELF.fetch(url, { headers });
        const body = (await res.json()) as { error: { code: string } };
        expect({ url, status: res.status, code: body.error.code }).toEqual({
          url,
          status: 401,
          code: "checkout_secret_required",
        });
      }
    }
  });
});
