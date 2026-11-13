/**
 * W3-G2.15-rest: the generic dock QR through the API as tidegrid_app
 * (owner decision 2026-11-13, migration 0043). A booking code and the
 * booker's last name find today's booking at its own operator only; a miss
 * answers one 404; a match starts a signing that opens through the usual
 * waiver session route. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { TEST_FAKE_SECRET } from "@tidegrid/domain-booking/testing";
import {
  adult,
  bookParty,
  createWaiverFixture,
  fixtureHooks,
  nameParticipant,
  type WaiverFixture,
} from "@tidegrid/domain-waivers/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };
type Res = { status: number; headers: Headers; json: Json };

const env = inject("integrationDb");

describe.skipIf(!env)("W3-G2.15-rest: the dock QR lookup through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let A: WaiverFixture;
  let B: WaiverFixture;
  let hooks: BookingHooks;
  let tripIndex = 0;
  let ip = 0;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: "https://console.test",
    STAFF_ORIGINS: "https://console.test",
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function post(
    tenant: WaiverFixture,
    path: string,
    body: unknown,
    opts: { bearer?: string; ip?: string | undefined } = {},
  ): Promise<Res> {
    ip += 1;
    const headers = new Headers({
      origin: `https://${tenant.host}`,
      "content-type": "application/json",
      "cf-connecting-ip": opts.ip ?? `203.0.113.${ip % 250}`,
    });
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    const res = await app.request(
      `http://localhost${path}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      bindings(),
      executionCtx,
    );
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: text ? (JSON.parse(text) as Json) : {},
    };
  }

  /** A booking of one named adult whose trip departs a minute ago, on a boat of its own. */
  async function todaysBooking(t: WaiverFixture) {
    const tripId = t.trips.shared[tripIndex++];
    if (!tripId) throw new Error("out of trips");
    const booked = await bookParty(admin, runtime.db, t, tripId, 1, hooks);
    await nameParticipant(runtime.db, t.id, booked.bookingId, 1, adult("Dee Docker"), hooks);
    await admin.begin(async (tx) => {
      await tx`alter table public.scheduled_trips disable trigger scheduled_trips_consistency`;
      const [boat] = await tx<{ id: string }[]>`
        insert into public.boats (tenant_id, name, guest_capacity)
        select b.tenant_id, ${`Dock ${randomUUID().slice(0, 8)}`}, b.guest_capacity
          from public.scheduled_trips t join public.boats b on b.tenant_id = t.tenant_id and b.id = t.boat_id
         where t.id = ${tripId}
        returning id`;
      await tx`insert into public.product_boats (tenant_id, product_id, boat_id)
               select tenant_id, product_id, ${boat?.id ?? ""} from public.scheduled_trips where id = ${tripId}`;
      await tx`update public.scheduled_trips
                  set boat_id = ${boat?.id ?? ""}, schedule_id = null,
                      boat_free_at = now() - interval '1 minute' + (boat_free_at - starts_at),
                      ends_at = now() - interval '1 minute' + (ends_at - starts_at),
                      starts_at = now() - interval '1 minute'
                where id = ${tripId}`;
      await tx`alter table public.scheduled_trips enable trigger scheduled_trips_consistency`;
    });
    return booked;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    hooks = fixtureHooks();
    app = createApp({});
    A = await createWaiverFixture(admin, runtime.db, "dockapi-a", { days: 6 });
    B = await createWaiverFixture(admin, runtime.db, "dockapi-b", { days: 2 });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("finds today's party, starts a signing, and opens it through the waiver session route", async () => {
    const booked = await todaysBooking(A);
    const found = await post(A, "/v1/public/waiver-dock/lookups", {
      bookingCode: booked.reference.toLowerCase(),
      lastName: "booker",
    });
    expect(found.status).toBe(201);
    expect(found.headers.get("cache-control")).toBe("no-store");
    const secret = String(found.json.lookupSecret);
    expect(found.json.party).toMatchObject({
      people: [
        { position: 1, name: "Dee D.", minor: false, status: "to_sign", signer: "participant" },
      ],
    });

    // No bearer, or another operator's site, starts nothing.
    expect(
      (await post(A, "/v1/public/waiver-dock/signings", { position: 1 })).json.error?.code,
    ).toBe("dock_lookup_ended");
    expect(
      (await post(B, "/v1/public/waiver-dock/signings", { position: 1 }, { bearer: secret }))
        .status,
    ).toBe(401);

    const started = await post(
      A,
      "/v1/public/waiver-dock/signings",
      { position: 1 },
      { bearer: secret },
    );
    expect(started.status).toBe(201);
    const path = String(started.json.path);
    expect(path).toMatch(/^\/waiver#t=[A-Za-z0-9_-]{43}$/);
    const opened = await post(A, "/v1/public/waiver-sessions", { token: path.split("#t=")[1] });
    expect(opened.status).toBe(201);
    expect((opened.json.waiver as Record<string, unknown>).access).toBe("dock_lookup");
  });

  it("answers every miss with one 404, and holds tries past the limit", async () => {
    const booked = await todaysBooking(A);
    const miss = (body: unknown, at?: string) =>
      post(A, "/v1/public/waiver-dock/lookups", body, { ip: at });
    const wrongName = await miss({ bookingCode: booked.reference, lastName: "Nobody" });
    const unknown = await miss({ bookingCode: "ZZZZZZZZ", lastName: "Booker" });
    const elsewhere = await post(B, "/v1/public/waiver-dock/lookups", {
      bookingCode: booked.reference,
      lastName: "Booker",
    });
    for (const r of [wrongName, unknown, elsewhere]) {
      expect(r.status).toBe(404);
      expect(r.json.error?.code).toBe("dock_lookup_not_found");
      expect(r.json.error?.message).toBe(wrongName.json.error?.message);
    }
    expect((await miss({ bookingCode: "#?", lastName: "Booker" })).json.error?.code).toBe(
      "dock_code_invalid",
    );
    const one = "192.0.2.77";
    for (let i = 0; i < 20; i++) {
      expect(
        (
          await miss(
            { bookingCode: `YYYYY${String(i).padStart(2, "0")}0`, lastName: "Nobody" },
            one,
          )
        ).status,
      ).toBe(404);
    }
    const held = await miss({ bookingCode: booked.reference, lastName: "Booker" }, one);
    expect(held.status).toBe(429);
    expect(held.json.error?.code).toBe("dock_lookup_limited");
  });
});
