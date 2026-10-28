import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { runCommand, UsageError } from "./commands.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("hostname CLI on a throwaway database", () => {
  let handle: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const slug = `cli-${run}`;
  const host = `book-${run}.example.com`;

  beforeAll(async () => {
    if (!env) return;
    handle = createDb(env.adminUrl, { max: 1 });
    await handle.sql`insert into public.tenants (id, slug, display_name)
      values (${randomUUID()}, ${slug}, 'CLI Tenant')`;
  });
  afterAll(async () => {
    await handle?.end();
  });

  it("runs the whole fake lifecycle in one process", async () => {
    const lines = await runCommand(
      handle.db,
      { kind: "fake-lifecycle", slug, hostname: host },
      { TIDEGRID_EPHEMERAL_DB: "1" },
    );
    expect(lines).toEqual([
      "request: requested",
      "resolves before validation: false",
      "activate before validation: not_ready",
      "activate after validation: activated",
      "resolves when active: true",
      "sweep after the CNAME moved: 1 demoted",
      "resolves after demotion: false",
      "disable: already disabled",
    ]);
    const status = await runCommand(handle.db, { kind: "status", slug }, {});
    expect(status).toEqual([`${host}  custom  disabled  hostname moved  certificate active`]);
  });

  it("refuses the fake outside a throwaway database and an unknown tenant", async () => {
    await expect(
      runCommand(handle.db, { kind: "fake-lifecycle", slug, hostname: `x-${host}` }, {}),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runCommand(handle.db, { kind: "status", slug: `nobody-${run}` }, {}),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
