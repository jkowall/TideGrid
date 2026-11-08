import {
  HostnameProviderRejectedError,
  HostnameProviderUnavailableError,
  isAccountLevelRefusal,
} from "@tidegrid/domain-hostnames";
import { describe, expect, it } from "vitest";
import {
  applyRoutePlan,
  createWorkersRoutesClient,
  DEFAULT_ROUTE_SCRIPT,
  describeOutcome,
  describePlan,
  planRoute,
  routePattern,
} from "./routes.ts";

const zoneId = "023e105f4ecef8ad9ca31a8372d0c353";
const apiToken = "test-token-Rt6Vb8NcZq7Kx2Lm9Pw4";
const host = "book.example.com";
const base = `/client/v4/zones/${zoneId}/workers/routes`;

/**
 * A recorded-shape Workers Routes endpoint for one zone (W1-SAAS-PREP),
 * modeled on the API reference. Synthetic names only; never the real API.
 */
function routesFixture(initial: { pattern: string; script: string | null }[] = []) {
  let sequence = 0;
  const routes = new Map<string, { id: string; pattern: string; script: string | null }>();
  const add = (pattern: string, script: string | null) => {
    sequence += 1;
    const id = `${sequence.toString(16).padStart(32, "0")}`;
    routes.set(id, { id, pattern, script });
    return routes.get(id);
  };
  for (const r of initial) add(r.pattern, r.script);
  const requests: { method: string; path: string; body: unknown; authorized: boolean }[] = [];
  const scripted: { status: number; body: string }[] = [];
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetcher = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "POST" ? await request.text() : "";
    const body = text ? JSON.parse(text) : null;
    const authorized = request.headers.get("authorization") === `Bearer ${apiToken}`;
    requests.push({ method: request.method, path: url.pathname, body, authorized });
    const script = scripted.shift();
    if (script) return new Response(script.body, { status: script.status });
    if (!authorized) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          messages: [],
          result: null,
        }),
        { status: 403 },
      );
    }
    if (url.pathname === base && request.method === "GET") return ok([...routes.values()]);
    if (url.pathname === base && request.method === "POST") {
      return ok(add(body.pattern, body.script));
    }
    const id = url.pathname.slice(base.length + 1);
    if (request.method === "DELETE" && routes.delete(id)) return ok({ id });
    return new Response(
      JSON.stringify({ success: false, errors: [{ code: 10007, message: "not found" }] }),
      { status: 404 },
    );
  }) as typeof fetch;
  const client = (token = apiToken) =>
    createWorkersRoutesClient({ zoneId, apiToken: token, fetch: fetcher });
  return {
    client,
    requests,
    routes: () => [...routes.values()],
    answerNext: (status: number, body: string) => scripted.push({ status, body }),
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("per-hostname route plans (W1-SAAS-PREP, proposed)", () => {
  it("routes exactly <hostname>/* to the guest Worker by default", () => {
    expect(routePattern(host)).toBe("book.example.com/*");
    expect(planRoute("add", host, DEFAULT_ROUTE_SCRIPT)).toEqual({
      action: "add",
      hostname: host,
      pattern: "book.example.com/*",
      script: "tidegrid-guest",
    });
    for (const bad of ["", "Tidegrid", "a b", "../x", "x".repeat(64)]) {
      expect(() => planRoute("add", host, bad), bad).toThrow(TypeError);
    }
  });

  it("describes a dry run without the zone id and without a call", () => {
    const fixture = routesFixture();
    const lines = [
      ...describePlan(planRoute("add", host, "tidegrid-guest")),
      ...describePlan(planRoute("remove", host, "tidegrid-guest")),
    ];
    expect(lines[0]).toBe(`${host}: dry run, no call made`);
    expect(lines.join("\n")).toContain(
      'POST /zones/$CF_SAAS_ZONE_ID/workers/routes {"pattern":"book.example.com/*","script":"tidegrid-guest"}',
    );
    expect(lines.join("\n")).toContain("DELETE /zones/$CF_SAAS_ZONE_ID/workers/routes/<route id>");
    expect(lines.join("\n")).not.toContain(zoneId);
    expect(fixture.requests).toHaveLength(0);
  });

  it("creates a route once, then leaves it alone", async () => {
    const fixture = routesFixture([{ pattern: "other.example.com/*", script: "tidegrid-guest" }]);
    const plan = planRoute("add", host, "tidegrid-guest");
    const first = await applyRoutePlan(fixture.client(), plan);
    expect(first.kind).toBe("routed");
    const second = await applyRoutePlan(fixture.client(), plan);
    expect(second).toEqual({
      kind: "already_routed",
      routeId: first.kind === "routed" ? first.routeId : "",
    });
    expect(fixture.requests.map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
    expect(fixture.requests[1]?.body).toEqual({
      pattern: "book.example.com/*",
      script: "tidegrid-guest",
    });
    expect(fixture.requests.every((r) => r.authorized)).toBe(true);
    expect(describeOutcome(plan, second)[0]).toContain("already routed");
  });

  it("refuses a pattern that routes to another script, and never replaces or deletes it", async () => {
    for (const script of ["someone-else", null]) {
      const fixture = routesFixture([{ pattern: "book.example.com/*", script }]);
      for (const action of ["add", "remove"] as const) {
        const plan = planRoute(action, host, "tidegrid-guest");
        const outcome = await applyRoutePlan(fixture.client(), plan);
        expect(outcome).toEqual({ kind: "conflict", script });
        expect(describeOutcome(plan, outcome)[0]).toContain("refused");
      }
      expect(fixture.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
      expect(fixture.routes()).toHaveLength(1);
    }
  });

  it("removes only the route the plan names", async () => {
    const fixture = routesFixture([
      { pattern: "book.example.com/*", script: "tidegrid-guest" },
      { pattern: "book.example.com/api/*", script: "tidegrid-guest" },
      { pattern: "*/*", script: "tidegrid-guest" },
    ]);
    const plan = planRoute("remove", host, "tidegrid-guest");
    const outcome = await applyRoutePlan(fixture.client(), plan);
    expect(outcome.kind).toBe("removed");
    expect(fixture.routes().map((r) => r.pattern)).toEqual(["book.example.com/api/*", "*/*"]);
    expect(await applyRoutePlan(fixture.client(), plan)).toEqual({ kind: "no_route" });
  });

  it("maps a refused token to an account-level refusal, never carrying the token", async () => {
    const fixture = routesFixture();
    const error = await caught(fixture.client(`${apiToken}-rotated`).list());
    expect(error).toBeInstanceOf(HostnameProviderRejectedError);
    expect((error as HostnameProviderRejectedError).code).toBe("cloudflare_10000");
    expect(isAccountLevelRefusal(error)).toBe(true);
    expect(JSON.stringify({ ...(error as object), m: String(error) })).not.toContain(apiToken);
  });

  it("reads 429 and 5xx as unavailable, and anything unparsed as malformed", async () => {
    const fixture = routesFixture();
    fixture.answerNext(429, "{}");
    expect(await caught(fixture.client().list())).toBeInstanceOf(HostnameProviderUnavailableError);
    fixture.answerNext(502, "<html></html>");
    expect(await caught(fixture.client().list())).toBeInstanceOf(HostnameProviderUnavailableError);
    for (const body of [
      "not json",
      JSON.stringify({ success: true, result: {} }),
      JSON.stringify({ success: true, result: [{ id: "../x", pattern: "a/*" }] }),
      JSON.stringify({ success: false, result: [] }),
    ]) {
      fixture.answerNext(200, body);
      const error = (await caught(fixture.client().list())) as HostnameProviderRejectedError;
      expect(error.code).toBe("malformed_response");
    }
  });

  it("accepts a create answer that carries the id alone, and refuses one that names another pattern", async () => {
    const fixture = routesFixture();
    fixture.answerNext(200, JSON.stringify({ success: true, result: [] }));
    fixture.answerNext(200, JSON.stringify({ success: true, result: { id: "abc123" } }));
    const plan = planRoute("add", host, "tidegrid-guest");
    expect(await applyRoutePlan(fixture.client(), plan)).toEqual({
      kind: "routed",
      routeId: "abc123",
    });
    fixture.answerNext(200, JSON.stringify({ success: true, result: [] }));
    fixture.answerNext(
      200,
      JSON.stringify({ success: true, result: { id: "abc124", pattern: "*/*", script: "x" } }),
    );
    const error = (await caught(
      applyRoutePlan(fixture.client(), plan),
    )) as HostnameProviderRejectedError;
    expect(error.code).toBe("malformed_response");
  });

  it("refuses a bad zone id, token, or API base at construction", () => {
    const make = (overrides: Record<string, unknown>) => () =>
      createWorkersRoutesClient({ zoneId, apiToken, ...overrides });
    expect(make({})).not.toThrow();
    for (const bad of ["", zoneId.toUpperCase(), `${zoneId}0`, `${zoneId.slice(1)}/`]) {
      expect(make({ zoneId: bad })).toThrow(TypeError);
    }
    expect(make({ apiToken: " " })).toThrow(TypeError);
    expect(make({ apiBase: "http://api.cloudflare.com/client/v4" })).toThrow(TypeError);
  });
});
