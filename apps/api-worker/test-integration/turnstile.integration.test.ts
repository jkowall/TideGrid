/**
 * W3-OPS-4: the Turnstile check on the public writes a script could abuse
 * (src/turnstile.ts), through the whole API: the waiver link renewal, the dock
 * lookup, and opening a checkout; and the site key in the tenant bootstrap.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { TEST_FAKE_SECRET } from "@tidegrid/domain-booking/testing";
import { createWaiverFixture, type WaiverFixture } from "@tidegrid/domain-waivers/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { SiteverifyResult } from "../src/turnstile.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W3-OPS-4: Turnstile on public writes", () => {
  let admin: ReturnType<typeof postgres>;
  let runtime: ReturnType<typeof createDb>;
  let A: WaiverFixture;
  let answer: () => Promise<SiteverifyResult>;
  const seen: { secret: string; response: string; remoteip: string | null }[] = [];
  const app = createApp({
    siteverify: async (form) => {
      seen.push(form);
      return answer();
    },
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  const bindings = (extra: Record<string, unknown>) => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: "https://console.test",
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    PUBLIC_CORS: "dynamic",
    ...extra,
  });

  async function post(path: string, body: unknown, extra: Record<string, unknown>, token?: string) {
    const headers = new Headers({
      origin: `https://${A.host}`,
      "content-type": "application/json",
      "cf-connecting-ip": "198.51.100.9",
      "idempotency-key": randomUUID(),
    });
    if (token) headers.set("turnstile-token", token);
    const res = await app.request(
      `http://localhost${path}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      bindings(extra),
      executionCtx,
    );
    const json = (await res.json().catch(() => ({}))) as { error?: { code: string } };
    return { status: res.status, code: json.error?.code };
  }

  const renewal = (extra: Record<string, unknown>, token?: string) =>
    post("/v1/public/waiver-links/renewal", { token: "x".repeat(43) }, extra, token);
  const keyed = { TURNSTILE_SECRET_KEY: "test-secret", TURNSTILE_SITE_KEY: "0x4AAAAAAAsite" };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    A = await createWaiverFixture(admin, runtime.db, "ts", { days: 2 });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("skips the check in local and preview without a secret, and refuses in staging and production", async () => {
    expect((await renewal({})).status).toBe(202);
    expect(await renewal({ ENVIRONMENT: "preview" })).toMatchObject({ status: 202 });
    for (const environment of ["staging", "production"]) {
      expect(await renewal({ ENVIRONMENT: environment })).toEqual({
        status: 503,
        code: "human_check_unavailable",
      });
    }
  });

  it("needs a token Cloudflare confirms, for this action, on the request's own host", async () => {
    answer = async () => ({ success: true, action: "waiver_renewal", hostname: A.host });
    expect(await renewal(keyed)).toEqual({ status: 403, code: "human_check_required" });
    expect((await renewal(keyed, "tok-1")).status).toBe(202);
    expect(seen.at(-1)).toEqual({
      secret: "test-secret",
      response: "tok-1",
      remoteip: "198.51.100.9",
    });

    for (const wrong of [
      { success: false, "error-codes": ["timeout-or-duplicate"] },
      { success: true, action: "checkout", hostname: A.host },
      { success: true, action: "waiver_renewal", hostname: "elsewhere.example.test" },
    ]) {
      answer = async () => wrong;
      expect(await renewal(keyed, "tok-2")).toEqual({ status: 403, code: "human_check_failed" });
    }
    answer = async () => {
      throw new Error("unreachable");
    };
    expect(await renewal(keyed, "tok-3")).toEqual({
      status: 503,
      code: "human_check_unavailable",
    });
  });

  it("guards the dock lookup and opening a checkout before any database work", async () => {
    answer = async () => ({ success: true, action: "waiver_renewal", hostname: A.host });
    const dock = await post(
      "/v1/public/waiver-dock/lookups",
      { bookingCode: "ABC234", lastName: "Doe" },
      keyed,
    );
    expect(dock).toEqual({ status: 403, code: "human_check_required" });
    // A token for another action does not open a checkout.
    const checkout = await post(
      "/v1/public/checkout-sessions",
      {
        quoteId: randomUUID(),
        acceptedPolicyVersion: 1,
        checkoutSecret: "c".repeat(43),
        booker: { name: "Ann Adult", email: "ann@example.test" },
      },
      keyed,
      "tok-4",
    );
    expect([checkout.status, checkout.code]).toEqual([403, "human_check_failed"]);
  });

  it("offers the site key in the tenant bootstrap only where the API checks", async () => {
    const boot = async (extra: Record<string, unknown>) => {
      const res = await app.request(
        "http://localhost/v1/public/tenant",
        { headers: { origin: `https://${A.host}` } },
        bindings(extra),
        executionCtx,
      );
      return (await res.json()) as { humanCheck?: unknown };
    };
    expect((await boot({})).humanCheck).toBeUndefined();
    expect((await boot({ TURNSTILE_SITE_KEY: "0x4AAAAAAAsite" })).humanCheck).toBeUndefined();
    expect((await boot(keyed)).humanCheck).toEqual({
      provider: "turnstile",
      siteKey: "0x4AAAAAAAsite",
    });
  });
});
