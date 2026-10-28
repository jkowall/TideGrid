import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { guestOriginFor } from "./delivery.ts";

const env = inject("integrationDb");

/**
 * Where an email's link points (G2.14b): the link origin goes through the
 * strict origin parser with the deployment's environment, and must resolve
 * to an active, verified hostname of the same tenant. Two tenants throughout.
 */
describe.skipIf(!env)("guest link origins", () => {
  let admin: ReturnType<typeof postgres>;
  let runtime: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const A = { id: randomUUID(), slug: `go-a-${run}` };
  const B = { id: randomUUID(), slug: `go-b-${run}` };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 1, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 1 });
    await admin`insert into public.tenants (id, slug, display_name) values
      (${A.id}, ${A.slug}, 'Origin A'), (${B.id}, ${B.slug}, 'Origin B')`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at) values
      (${`${A.slug}.book.localhost`}, ${A.id}, 'preview', 'active', now()),
      (${`${A.slug}.book.example.com`}, ${A.id}, 'preview', 'active', now()),
      (${`${B.slug}.book.example.com`}, ${B.id}, 'preview', 'active', now())`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status) values
      (${`${A.slug}.pending.example.com`}, ${A.id}, 'custom', 'pending')`;
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("allows a *.localhost link origin only in local development", async () => {
    const template = "http://{slug}.book.localhost:5361";
    expect(await guestOriginFor(runtime.db, A.id, A.slug, template, "local")).toBe(
      `http://${A.slug}.book.localhost:5361`,
    );
    for (const environment of ["preview", "staging", "production"] as const) {
      expect(await guestOriginFor(runtime.db, A.id, A.slug, template, environment)).toBeNull();
      expect(
        await guestOriginFor(
          runtime.db,
          A.id,
          A.slug,
          "https://{slug}.book.localhost",
          environment,
        ),
      ).toBeNull();
    }
  });

  it("resolves only to an active hostname of the same tenant, under the strict parser", async () => {
    const https = "https://{slug}.book.example.com";
    for (const environment of ["local", "preview"] as const) {
      expect(await guestOriginFor(runtime.db, A.id, A.slug, https, environment)).toBe(
        `https://${A.slug}.book.example.com`,
      );
      // B's own site, asked for A: refused. A pending host: refused.
      expect(await guestOriginFor(runtime.db, A.id, B.slug, https, environment)).toBeNull();
      expect(
        await guestOriginFor(
          runtime.db,
          A.id,
          A.slug,
          "https://{slug}.pending.example.com",
          environment,
        ),
      ).toBeNull();
      for (const bad of [
        "https://{slug}.book.example.com.",
        "https://{slug}.book.example.com:443",
        "https://{slug}.book.example.com/elsewhere",
        "https://{slug}.book.example.com?x=1",
        "http://{slug}.book.example.com",
        "https://user@{slug}.book.example.com",
        "not a url",
      ]) {
        expect({
          bad,
          environment,
          origin: await guestOriginFor(runtime.db, A.id, A.slug, bad, environment),
        }).toEqual({ bad, environment, origin: null });
      }
    }
    // An explicit port is a local-only allowance.
    expect(
      await guestOriginFor(
        runtime.db,
        A.id,
        A.slug,
        "https://{slug}.book.example.com:8443",
        "preview",
      ),
    ).toBeNull();
  });
});
