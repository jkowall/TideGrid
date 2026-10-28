/**
 * Hostname resolution and CORS through the API (G2.14b), against a real
 * PostgreSQL 17 as the runtime role, with two tenants throughout. Every case
 * runs under ENVIRONMENT "local" and "preview", so the rules that differ
 * outside local development are exercised, not only asserted.
 *
 * Contracts: the strict origin parser (packages/domain-hostnames/src/origin.ts),
 * the CORS rules (src/hostnames/cors.ts), and the tenant isolation contract
 * in packages/database/README.md.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { type CheckoutFixture, createCheckoutFixture } from "@tidegrid/domain-booking/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { PREFLIGHT_TTL_MS, preflightProjection } from "../src/hostnames/cors.ts";
import { resolveGuestHost } from "../src/hostnames/guest-gateway.ts";

type Sql = ReturnType<typeof postgres>;
type Json = { error?: { code: string; message: string; requestId: string } } & Record<
  string,
  unknown
>;

const env = inject("integrationDb");
const environments = ["local", "preview"] as const;
type Environment = (typeof environments)[number];

describe.skipIf(!env)("hostname resolution and CORS through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  const run = randomUUID().slice(0, 8);
  const hosts = {
    a: "",
    b: "",
    aLocal: "",
    aPending: `pending-${run}.example.com`,
    bDisabled: `disabled-${run}.example.com`,
    aLater: `later-${run}.example.com`,
    unknown: `nobody-${run}.example.com`,
  };

  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };

  function bindings(environment: Environment) {
    return {
      ENVIRONMENT: environment,
      BUILD_ID: "integration",
      DATABASE_URL: env?.runtimeUrl ?? "",
      ALLOWED_ORIGINS: "https://console.test",
      PAYMENT_PROVIDER: "fake",
      FAKE_PAYMENT_WEBHOOK_SECRET: "g214b-integration-fake-secret-0123456789abcdef",
    };
  }

  async function call(
    environment: Environment,
    path: string,
    origin: string | null,
    init: { method?: string; headers?: Record<string, string> } = {},
  ) {
    const headers = new Headers(init.headers);
    if (origin) headers.set("origin", origin);
    const res = await app.request(
      `http://localhost${path}`,
      { method: init.method ?? "GET", headers },
      bindings(environment),
      executionCtx,
    );
    await Promise.allSettled(pending.splice(0));
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = {};
    }
    return { res, json, text };
  }

  /** One route of every kind a guest page calls, each resolving the Origin first. */
  function routes(tenant: CheckoutFixture) {
    const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const trip = tenant.trips.shared.at(-1) ?? "00000000-0000-4000-8000-000000000000";
    const id = "00000000-0000-4000-8000-000000000000";
    return [
      `/v1/public/trips?from=${from}&to=${to}&party=1`,
      `/v1/public/trips/${trip}/offer`,
      `/v1/public/quotes/${id}`,
      `/v1/public/checkout-sessions/${id}`,
      "/v1/public/manage/booking",
      "/v1/public/waiver-sessions/current",
      "/v1/fake-provider/payments/fake_pay_unknown",
    ];
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    app = createApp({ deliverEmailAfterCommit: false });
    A = await createCheckoutFixture(admin, runtime.db, `hn-api-a-${run}`);
    B = await createCheckoutFixture(admin, runtime.db, `hn-api-b-${run}`);
    hosts.a = `${A.slug}.book.example.com`;
    hosts.b = `${B.slug}.book.example.com`;
    hosts.aLocal = `${A.slug}.book.localhost`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at) values
      (${hosts.a}, ${A.id}, 'preview', 'active', now()),
      (${hosts.b}, ${B.id}, 'preview', 'active', now()),
      (${hosts.aLocal}, ${A.id}, 'preview', 'active', now()),
      (${hosts.aLater}, ${A.id}, 'preview', 'active', now()),
      (${hosts.bDisabled}, ${B.id}, 'custom', 'disabled', now())`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status) values
      (${hosts.aPending}, ${A.id}, 'custom', 'pending')`;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  for (const environment of environments) {
    describe(`under ENVIRONMENT=${environment}`, () => {
      it("refuses every non-canonical form of a real host with the shared 404, on every route kind", async () => {
        const variants = [
          `https://${hosts.a}.`,
          `https://${hosts.a}:443`,
          `http://${hosts.a}`,
          `https://${hosts.a.toUpperCase()}`,
          "https://xn--bcher-kva.example.com",
          `https://user@${hosts.a}`,
          `https://${hosts.a}/path`,
        ];
        for (const path of ["/v1/public/tenant", ...routes(A)]) {
          for (const origin of variants) {
            const { res, json } = await call(environment, path, origin);
            expect({ path, origin, status: res.status, code: json.error?.code }).toEqual({
              path,
              origin,
              status: 404,
              code: "tenant_not_found",
            });
            expect(res.headers.get("access-control-allow-origin")).toBeNull();
            expect(res.headers.get("vary")).toMatch(/\bOrigin\b/);
          }
          // The canonical origin passes resolution (whatever the route answers next).
          const ok = await call(environment, path, `https://${hosts.a}`);
          expect({ path, code: ok.json.error?.code }).not.toEqual({
            path,
            code: "tenant_not_found",
          });
          expect(ok.res.headers.get("access-control-allow-origin")).toBe(`https://${hosts.a}`);
          expect(ok.res.headers.get("access-control-allow-credentials")).toBeNull();
          expect(ok.res.headers.get("vary")).toMatch(/\bOrigin\b/);
        }
      });

      it("grants no CORS to a pending, disabled, or unknown host on any route but the bootstrap", async () => {
        for (const host of [hosts.aPending, hosts.bDisabled, hosts.unknown]) {
          const origin = `https://${host}`;
          for (const path of routes(A)) {
            const simple = await call(environment, path, origin);
            expect({
              host,
              path,
              status: simple.res.status,
              code: simple.json.error?.code,
            }).toEqual({ host, path, status: 404, code: "tenant_not_found" });
            expect(simple.res.headers.get("access-control-allow-origin")).toBeNull();
            expect(simple.res.headers.get("vary")).toMatch(/\bOrigin\b/);
            const preflight = await call(environment, path, origin, {
              method: "OPTIONS",
              headers: {
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type,idempotency-key",
              },
            });
            expect(preflight.res.status).toBe(204);
            expect(preflight.res.headers.get("access-control-allow-origin")).toBeNull();
            expect(preflight.res.headers.get("vary")).toMatch(/\bOrigin\b/);
          }
          // The bootstrap's 404 is readable, so the page can show "not published".
          const boot = await call(environment, "/v1/public/tenant", origin);
          expect(boot.res.status).toBe(404);
          expect(boot.json.error?.code).toBe("tenant_not_found");
          expect(boot.res.headers.get("access-control-allow-origin")).toBe(origin);
          expect(boot.res.headers.get("cache-control")).toBeNull();
          expect(boot.res.headers.get("vary")).toMatch(/\bOrigin\b/);
        }
      });

      it("answers preflights and simple requests alike for a verified host", async () => {
        const origin = `https://${hosts.b}`;
        preflightProjection.clear();
        for (const path of ["/v1/public/quotes", "/v1/public/checkout-sessions"]) {
          const preflight = await call(environment, path, origin, {
            method: "OPTIONS",
            headers: { "access-control-request-method": "POST" },
          });
          expect(preflight.res.headers.get("access-control-allow-origin")).toBe(origin);
          expect(preflight.res.headers.get("access-control-allow-credentials")).toBeNull();
          expect(preflight.res.headers.get("vary")).toMatch(/\bOrigin\b/);
        }
        const simple = await call(environment, routes(B)[0] ?? "", origin);
        expect(simple.res.status).toBe(200);
        expect(simple.res.headers.get("access-control-allow-origin")).toBe(origin);
      });

      it("gives the same 404 from the catalog even with an invalid range", async () => {
        const expected = await call(environment, "/v1/public/tenant", `https://${hosts.unknown}`);
        for (const query of ["from=2099-12-30&to=2000-01-02", "party=0", "from=nope"]) {
          const { res, json } = await call(
            environment,
            `/v1/public/trips?${query}`,
            `https://${hosts.unknown}`,
          );
          expect({ query, status: res.status }).toEqual({ query, status: 404 });
          const { requestId: _a, ...body } = json.error ?? { requestId: "" };
          const { requestId: _b, ...boot } = expected.json.error ?? { requestId: "" };
          expect(body).toEqual(boot);
        }
        // A verified origin still gets the range check.
        const bad = await call(
          environment,
          "/v1/public/trips?from=2099-12-30&to=2000-01-02",
          `https://${hosts.a}`,
        );
        expect(bad.res.status).toBe(400);
      });

      it("never shows one tenant's trips or offers through another's origin", async () => {
        const offer = await call(
          environment,
          `/v1/public/trips/${B.trips.shared[0]}/offer`,
          `https://${hosts.a}`,
        );
        expect(offer.res.status).toBe(404);
        expect(offer.text).not.toContain(B.slug);
        const listA = await call(environment, routes(A)[0] ?? "", `https://${hosts.a}`);
        const tripIds = ((listA.json.trips as { tripId?: string; id?: string }[]) ?? []).map(
          (t) => t.tripId ?? t.id,
        );
        for (const id of B.trips.shared) expect(tripIds).not.toContain(id);
      });
    });
  }

  it("resolves a *.localhost row only in local development", async () => {
    const local = await call("local", "/v1/public/tenant", `http://${hosts.aLocal}:5361`);
    expect(local.res.status).toBe(200);
    expect(local.res.headers.get("access-control-allow-origin")).toBe(
      `http://${hosts.aLocal}:5361`,
    );
    for (const origin of [`http://${hosts.aLocal}:5361`, `https://${hosts.aLocal}`]) {
      const preview = await call("preview", "/v1/public/tenant", origin);
      expect({ origin, status: preview.res.status }).toEqual({ origin, status: 404 });
      const trips = await call("preview", routes(A)[0] ?? "", origin);
      expect(trips.res.status).toBe(404);
      expect(trips.res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("fails closed on the next request after a disable, within the 90 second bound", async () => {
    const origin = `https://${hosts.aLater}`;
    const before = await call("preview", "/v1/public/tenant", origin);
    expect(before.res.status).toBe(200);
    // A browser may keep the bootstrap for 60 seconds, and a preflight
    // projection lives 30: the stated bound is 90 seconds, or at once after a
    // hard reload. Data routes resolve every request, so they fail at once.
    expect(before.res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(PREFLIGHT_TTL_MS).toBe(30_000);
    await admin`select app.hostname_disable(${A.id}::uuid, ${hosts.aLater}, 'G2.14b integration')`;
    const after = await call("preview", "/v1/public/tenant", origin);
    expect(after.res.status).toBe(404);
    const trips = await call("preview", routes(A)[0] ?? "", origin);
    expect(trips.res.status).toBe(404);
    expect(trips.res.headers.get("access-control-allow-origin")).toBeNull();
    // The guest Worker's gateway now answers a definite miss as well.
    const gateway = {
      resolveHost: (h: string) => resolveGuestHost(bindings("preview") as never, h),
    };
    expect(await gateway.resolveHost(hosts.aLater)).toEqual({ kind: "miss" });
  });

  it("serves the guest Worker only public brand fields through GuestGateway", async () => {
    for (const environment of environments) {
      const gateway = {
        resolveHost: (h: string) => resolveGuestHost(bindings(environment) as never, h),
      };
      const answer = await gateway.resolveHost(hosts.a);
      expect(answer.kind).toBe("found");
      const text = JSON.stringify(answer);
      expect(text).not.toContain(A.id);
      for (const internal of ["tenant_id", "tenantId", "schema_version", "actor", "reason"]) {
        expect(text).not.toContain(internal);
      }
      if (answer.kind === "found") expect(answer.experience.tenant.slug).toBe(A.slug);
      for (const host of [hosts.aPending, hosts.bDisabled, hosts.unknown]) {
        expect(await gateway.resolveHost(host)).toEqual({ kind: "miss" });
      }
    }
    const local = { resolveHost: (h: string) => resolveGuestHost(bindings("local") as never, h) };
    expect((await local.resolveHost(hosts.aLocal)).kind).toBe("found");
    const preview = {
      resolveHost: (h: string) => resolveGuestHost(bindings("preview") as never, h),
    };
    expect(await preview.resolveHost(hosts.aLocal)).toEqual({ kind: "miss" });
  });

  it("answers with the static allowlist only when PUBLIC_CORS is static (the rollback)", async () => {
    const res = await app.request(
      "http://localhost/v1/public/tenant",
      { headers: { origin: `https://${hosts.unknown}` } },
      { ...bindings("preview"), PUBLIC_CORS: "static" },
      executionCtx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const verified = await app.request(
      "http://localhost/v1/public/tenant",
      { headers: { origin: `https://${hosts.a}` } },
      { ...bindings("preview"), PUBLIC_CORS: "static" },
      executionCtx,
    );
    expect(verified.status).toBe(200);
    expect(verified.headers.get("access-control-allow-origin")).toBeNull();
  });
});
