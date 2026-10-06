import { createHash, randomUUID } from "node:crypto";
import { StaffRole } from "@tidegrid/contracts";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  createDb,
  enqueueOutbox,
  IdempotencyKeyMismatchError,
  inTenantTransaction,
  recordAudit,
  type TenantContext,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
  return "no-error";
}

function sha(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function token64(): string {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}

describe.skipIf(!env)("tenancy, row-level security, and privileged functions", () => {
  let admin: Sql;
  let runtime: Sql;
  const run = randomUUID().slice(0, 8);
  const A = { id: randomUUID(), slug: `rls-a-${run}` };
  const B = { id: randomUUID(), slug: `rls-b-${run}` };
  const C = { id: randomUUID(), slug: `rls-c-${run}` }; // suspended
  const users = {
    ownerA: { id: randomUUID(), email: `owner-a-${run}@example.test` },
    ownerB: { id: randomUUID(), email: `owner-b-${run}@example.test` },
    shared: { id: randomUUID(), email: `shared-${run}@example.test` },
    outsider: { id: randomUUID(), email: `outsider-${run}@example.test` },
    disabled: { id: randomUUID(), email: `disabled-${run}@example.test` },
    limited: { id: randomUUID(), email: `limited-${run}@example.test` },
  };
  const hosts = {
    aPreview: `${A.slug}.book.example.test`,
    aPending: `pending-${run}.example.test`,
    bDisabled: `disabled-${run}.example.test`,
    cActive: `${C.slug}.book.example.test`,
  };

  /** One statement in one runtime transaction bound to `tenantId`. */
  function asTenant<T>(tenantId: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return runtime.begin(async (tx) => {
      if (tenantId) await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = postgres(env.runtimeUrl, { max: 4, onnotice: () => {} });
    await admin`insert into public.tenants (id, slug, display_name, status) values
      (${A.id}, ${A.slug}, 'RLS Tenant A', 'active'),
      (${B.id}, ${B.slug}, 'RLS Tenant B', 'active'),
      (${C.id}, ${C.slug}, 'RLS Tenant C', 'suspended')`;
    for (const u of Object.values(users)) {
      await admin`insert into public.staff_users (id, email, display_name, status)
        values (${u.id}, ${u.email}, ${u.email.split("@")[0] ?? "user"},
                ${u === users.disabled ? "disabled" : "active"})`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, status, display_name) values
      (${A.id}, ${users.ownerA.id}, 'owner', 'active', 'Fixture member'),
      (${A.id}, ${users.shared.id}, 'finance', 'active', 'Fixture member'),
      (${A.id}, ${users.disabled.id}, 'booking_staff', 'active', 'Fixture member'),
      (${B.id}, ${users.ownerB.id}, 'owner', 'active', 'Fixture member'),
      (${B.id}, ${users.shared.id}, 'booking_staff', 'active', 'Fixture member'),
      (${C.id}, ${users.shared.id}, 'owner', 'active', 'Fixture member')`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at) values
      (${hosts.aPreview}, ${A.id}, 'preview', 'active', now()),
      (${hosts.aPending}, ${A.id}, 'custom', 'pending', null),
      (${hosts.bDisabled}, ${B.id}, 'custom', 'disabled', now()),
      (${hosts.cActive}, ${C.id}, 'preview', 'active', now())`;
    for (const t of [A, B]) {
      await asTenant(t.id, async (tx) => {
        await tx`insert into public.audit_events (tenant_id, action, subject_type, subject_id)
          values (${t.id}, 'fixture.created', 'fixture', ${t.slug})`;
        await tx`insert into public.outbox_events (tenant_id, topic, aggregate_type, aggregate_id, payload)
          values (${t.id}, 'fixture.created', 'fixture', ${t.slug}, ${tx.json({ slug: t.slug })})`;
        await tx`insert into public.idempotency_keys (tenant_id, scope, principal, key, request_hash)
          values (${t.id}, 'fixture.create', 'system:fixture', ${`fixture-${run}`}, ${sha("f")})`;
      });
    }
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  const tenantTables = [
    "tenant_hostnames",
    "tenant_memberships",
    "audit_events",
    "idempotency_keys",
    "outbox_events",
  ] as const;

  it("sees no tenant rows and writes none without tenant context", async () => {
    for (const table of ["tenants", "staff_users", ...tenantTables]) {
      const [row] = await asTenant(
        null,
        (tx) => tx`select count(*)::int as n from ${tx(`public.${table}`)}`,
      );
      expect({ table, n: row?.n }).toEqual({ table, n: 0 });
    }
    expect(
      await pgError(
        asTenant(
          null,
          (tx) => tx`insert into public.audit_events (tenant_id, action, subject_type, subject_id)
            values (${A.id}, 'x.y', 'x', 'x')`,
        ),
      ),
    ).toBe("42501");
  });

  it("sees only its own rows inside a tenant transaction", async () => {
    const tenants = await asTenant(A.id, (tx) => tx`select id from public.tenants`);
    expect(tenants.map((r) => r.id)).toEqual([A.id]);

    const visibleUsers = await asTenant(A.id, (tx) => tx`select id from public.staff_users`);
    expect(visibleUsers.map((r) => r.id).sort()).toEqual(
      [users.ownerA.id, users.shared.id, users.disabled.id].sort(),
    );

    for (const table of tenantTables) {
      const rows = await asTenant(
        A.id,
        (tx) => tx`select distinct tenant_id from ${tx(`public.${table}`)}`,
      );
      expect({ table, tenants: rows.map((r) => r.tenant_id) }).toEqual({ table, tenants: [A.id] });
      const [leak] = await asTenant(
        A.id,
        (tx) =>
          tx`select count(*)::int as n from ${tx(`public.${table}`)} where tenant_id = ${B.id}`,
      );
      expect({ table, n: leak?.n }).toEqual({ table, n: 0 });
    }
  });

  it("cannot write into, move rows to, or mutate another tenant", async () => {
    const attempts: Array<[string, (tx: Sql) => Promise<unknown>]> = [
      [
        "audit for B",
        (tx) => tx`insert into public.audit_events (tenant_id, action, subject_type, subject_id)
          values (${B.id}, 'x.y', 'x', 'x')`,
      ],
      [
        "membership in B",
        (tx) => tx`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
          values (${B.id}, ${users.outsider.id}, 'owner', 'Fixture member')`,
      ],
      [
        "outbox for B",
        (
          tx,
        ) => tx`insert into public.outbox_events (tenant_id, topic, aggregate_type, aggregate_id, payload)
          values (${B.id}, 'x.y', 'x', 'x', '{}'::jsonb)`,
      ],
      [
        "idempotency for B",
        (
          tx,
        ) => tx`insert into public.idempotency_keys (tenant_id, scope, principal, key, request_hash)
          values (${B.id}, 'x', 'p', 'kkkkkkkk', ${sha("b")})`,
      ],
      [
        "move membership",
        (tx) =>
          tx`update public.tenant_memberships set tenant_id = ${B.id} where tenant_id = ${A.id}`,
      ],
      ["update audit", (tx) => tx`update public.audit_events set reason = 'x'`],
      ["delete membership", (tx) => tx`delete from public.tenant_memberships`],
      ["delete outbox", (tx) => tx`delete from public.outbox_events`],
      [
        "create tenant",
        (tx) => tx`insert into public.tenants (slug, display_name) values ('evil', 'Evil')`,
      ],
      [
        "create identity",
        (tx) =>
          tx`insert into public.staff_users (email, display_name) values ('evil@example.test', 'E')`,
      ],
      [
        "claim hostname",
        (tx) => tx`insert into public.tenant_hostnames (hostname, tenant_id, kind)
          values ('evil.example.test', ${A.id}, 'custom')`,
      ],
    ];
    for (const [label, attempt] of attempts) {
      expect({ label, code: await pgError(asTenant(A.id, attempt)) }).toEqual({
        label,
        code: "42501",
      });
    }
    const updated = await asTenant(
      A.id,
      (tx) => tx`update public.tenant_memberships set role = 'finance' where tenant_id = ${B.id}`,
    );
    expect(updated.count).toBe(0);
  });

  it("raises on a malformed tenant id instead of matching rows", async () => {
    const code = await pgError(
      runtime.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', 'not-a-uuid', true)`;
        await tx`select id from public.tenants`;
      }),
    );
    expect(code).toBe("22P02");
  });

  it("keeps audit and security events append-only for every role", async () => {
    expect(
      await pgError(asTenant(A.id, (tx) => tx`delete from public.audit_events where true`)),
    ).toBe("42501");
    expect(await pgError(admin`update public.audit_events set reason = 'x' where true`)).toBe(
      "55000",
    );
    expect(await pgError(admin`delete from public.audit_events where true`)).toBe("55000");
    expect(await pgError(admin`truncate public.audit_events`)).toBe("55000");
    // Row triggers fire only on existing rows, so make sure one exists.
    await admin`insert into public.security_events (kind, request_id)
      values ('login_link_rejected', ${`append-${run}`})`;
    expect(
      await pgError(admin`update public.security_events set request_id = 'x' where true`),
    ).toBe("55000");
    expect(await pgError(admin`delete from public.security_events where true`)).toBe("55000");
    expect(await pgError(admin`truncate public.security_events`)).toBe("55000");
  });

  it("gives the runtime no direct access to credential tables", async () => {
    for (const table of ["staff_login_tokens", "staff_sessions", "security_events"]) {
      expect({
        table,
        code: await pgError(asTenant(A.id, (tx) => tx`select * from ${tx(`public.${table}`)}`)),
      }).toEqual({ table, code: "42501" });
    }
  });

  it("resolves only active hostnames of active tenants", async () => {
    const resolve = (host: string) => runtime`select * from app.resolve_hostname(${host})`;
    const found = await resolve(hosts.aPreview);
    expect(found.map((r) => [r.tenant_id, r.tenant_slug, r.hostname_kind])).toEqual([
      [A.id, A.slug, "preview"],
    ]);
    expect((await resolve(hosts.aPreview.toUpperCase())).length).toBe(1);
    for (const host of [
      hosts.aPending,
      hosts.bDisabled,
      hosts.cActive,
      `nope-${run}.example.test`,
    ]) {
      expect({ host, rows: (await resolve(host)).length }).toEqual({ host, rows: 0 });
    }
  });

  it("maps identities and lists only active memberships in active tenants", async () => {
    const find = (email: string) => runtime`select * from app.auth_find_staff_by_email(${email})`;
    expect((await find(`  ${users.ownerA.email.toUpperCase()} `)).map((r) => r.user_id)).toEqual([
      users.ownerA.id,
    ]);
    expect((await find(users.disabled.email)).length).toBe(0);
    expect((await find(`unknown-${run}@example.test`)).length).toBe(0);

    const list = (id: string) => runtime`select * from app.auth_list_memberships(${id})`;
    const shared = await list(users.shared.id);
    expect(shared.map((r) => [r.tenant_id, r.role]).sort()).toEqual(
      [
        [A.id, "finance"],
        [B.id, "booking_staff"],
      ].sort(),
    );
    expect((await list(users.ownerA.id)).map((r) => r.tenant_id)).toEqual([A.id]);
  });

  it("creates identities only for an active tenant, ASCII only, named by their own address", async () => {
    const email = `new-${run}@example.test`;
    expect(await pgError(runtime`select app.ensure_staff_user(${email}, 'req-1')`)).toBe("42501");
    expect(
      await pgError(
        runtime.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', 'not-a-uuid', true)`;
          await tx`select app.ensure_staff_user(${email}, 'req-2')`;
        }),
      ),
    ).toBe("22P02");
    expect(
      await pgError(
        asTenant(randomUUID(), (tx) => tx`select app.ensure_staff_user(${email}, 'req-3')`),
      ),
    ).toBe("42501");
    expect(
      await pgError(asTenant(C.id, (tx) => tx`select app.ensure_staff_user(${email}, 'req-4')`)),
    ).toBe("42501");
    expect(
      await pgError(
        asTenant(
          A.id,
          (tx) => tx`select app.ensure_staff_user(${"\u212Aelvin@example.test"}, 'req-5')`,
        ),
      ),
    ).toBe("22023");

    const [first] = await asTenant(
      A.id,
      (tx) => tx`select app.ensure_staff_user(${email.toUpperCase()}, 'req-6') as id`,
    );
    const [again] = await asTenant(
      B.id,
      (tx) => tx`select app.ensure_staff_user(${email}, 'req-7') as id`,
    );
    expect(first?.id).toBeTruthy();
    expect(again?.id).toBe(first?.id);
    const [stored] =
      await admin`select email, display_name from public.staff_users where id = ${first?.id}`;
    expect(stored).toEqual({ email, display_name: email.split("@")[0] });
  });

  it("withholds an identity's own display name from every tenant", async () => {
    expect(
      await pgError(asTenant(A.id, (tx) => tx`select display_name from public.staff_users`)),
    ).toBe("42501");
    const names = await asTenant(
      A.id,
      (tx) => tx`select display_name from public.tenant_memberships where tenant_id = ${A.id}`,
    );
    expect(names.length).toBeGreaterThan(0);
  });

  it("refuses to reuse a connection that carries a leaked session-level tenant", async () => {
    const handle = createDb(env?.runtimeUrl ?? "", { max: 1 });
    try {
      await handle.sql`select set_config('app.tenant_id', ${A.id}, false)`;
      await expect(
        inTenantTransaction(handle.db, { tenantId: B.id, actorType: "system" }, async () => 1),
      ).rejects.toThrow(/already set on this connection/);
    } finally {
      await handle.end();
    }
  });

  it("issues single-use, expiring, rate-limited login tokens and revocable sessions", async () => {
    const issue = (email: string, hash: string) =>
      runtime`select app.auth_issue_login_token(${email}, ${hash}, 900, 'req') as outcome`.then(
        (r) => r[0]?.outcome,
      );
    const consume = (hash: string, sessionHash: string) =>
      runtime`select * from app.auth_consume_login_token(${hash}, ${sessionHash}, 3600, 'req')`;

    const t1 = token64();
    const s1 = token64();
    expect(await issue(users.ownerA.email, t1)).toBe("issued");
    const opened = await consume(t1, s1);
    expect(opened.map((r) => r.user_id)).toEqual([users.ownerA.id]);
    expect((await consume(t1, token64())).length).toBe(0);

    const resolve = (hash: string) => runtime`select * from app.auth_resolve_session(${hash})`;
    expect((await resolve(s1)).map((r) => r.user_id)).toEqual([users.ownerA.id]);
    const revoke = (hash: string) =>
      runtime`select app.auth_revoke_session(${hash}, 'req') as ok`.then((r) => r[0]?.ok);
    expect(await revoke(s1)).toBe(true);
    expect(await revoke(s1)).toBe(false);
    expect((await resolve(s1)).length).toBe(0);

    const t2 = token64();
    expect(await issue(users.ownerA.email, t2)).toBe("issued");
    await admin`update public.staff_login_tokens set expires_at = now() - interval '1 second' where token_hash = ${t2}`;
    expect((await consume(t2, token64())).length).toBe(0);

    const t3 = token64();
    const s3 = token64();
    expect(await issue(users.ownerB.email, t3)).toBe("issued");
    expect((await consume(t3, s3)).length).toBe(1);
    await admin`update public.staff_sessions set expires_at = now() - interval '1 second' where session_hash = ${s3}`;
    expect((await resolve(s3)).length).toBe(0);

    expect(await issue(users.disabled.email, token64())).toBe("unknown");
    expect(await issue(`unknown-${run}@example.test`, token64())).toBe("unknown");

    const outcomes: unknown[] = [];
    for (let i = 0; i < 6; i++) outcomes.push(await issue(users.limited.email, token64()));
    expect(outcomes).toEqual(["issued", "issued", "issued", "issued", "issued", "rate_limited"]);
  });

  describe("idempotency", () => {
    const ctx = (tenantId: string): TenantContext => ({
      tenantId,
      actorType: "staff",
      actorId: users.ownerA.id,
      requestId: `idem-${run}`,
    });

    function gate() {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    }

    it("blocks a concurrent duplicate until the first commits, then replays it", async () => {
      const first = createDb(env?.runtimeUrl ?? "", { max: 1 });
      const second = createDb(env?.runtimeUrl ?? "", { max: 1 });
      try {
        const claim = {
          scope: "test.create",
          principal: "staff:a",
          key: `k-commit-${run}`,
          requestHash: sha("c"),
        };
        const claimed = gate();
        const release = gate();
        const t1 = inTenantTransaction(first.db, ctx(A.id), async (trx) => {
          expect(await claimIdempotencyKey(trx, ctx(A.id), claim)).toEqual({ kind: "new" });
          claimed.open();
          await release.opened;
          await recordAudit(trx, ctx(A.id), {
            action: "test.created",
            subjectType: "test",
            subjectId: claim.key,
          });
          await completeIdempotencyKey(trx, ctx(A.id), claim, { status: 201, body: { n: 1 } });
        });
        await claimed.opened;
        let secondSettled = false;
        const t2 = inTenantTransaction(second.db, ctx(A.id), (trx) =>
          claimIdempotencyKey(trx, ctx(A.id), claim),
        ).finally(() => {
          secondSettled = true;
        });
        await new Promise((r) => setTimeout(r, 750));
        expect(secondSettled).toBe(false);
        release.open();
        await t1;
        expect(await t2).toEqual({ kind: "replay", status: 201, body: { n: 1 } });
        const [audits] = await admin`select count(*)::int as n from public.audit_events
          where tenant_id = ${A.id} and subject_id = ${claim.key}`;
        expect(audits?.n).toBe(1);
      } finally {
        await first.end();
        await second.end();
      }
    });

    it("lets the duplicate proceed when the first transaction rolls back", async () => {
      const first = createDb(env?.runtimeUrl ?? "", { max: 1 });
      const second = createDb(env?.runtimeUrl ?? "", { max: 1 });
      try {
        const claim = {
          scope: "test.create",
          principal: "staff:a",
          key: `k-rollback-${run}`,
          requestHash: sha("r"),
        };
        const claimed = gate();
        const release = gate();
        const t1 = inTenantTransaction(first.db, ctx(A.id), async (trx) => {
          await claimIdempotencyKey(trx, ctx(A.id), claim);
          claimed.open();
          await release.opened;
          throw new Error("command failed");
        });
        await claimed.opened;
        const t2 = inTenantTransaction(second.db, ctx(A.id), async (trx) => {
          const result = await claimIdempotencyKey(trx, ctx(A.id), claim);
          await completeIdempotencyKey(trx, ctx(A.id), claim, { status: 200, body: { n: 2 } });
          return result;
        });
        await new Promise((r) => setTimeout(r, 300));
        release.open();
        await expect(t1).rejects.toThrow("command failed");
        expect(await t2).toEqual({ kind: "new" });
      } finally {
        await first.end();
        await second.end();
      }
    });

    it("rejects a reused key with a different request and isolates principals and tenants", async () => {
      const handle = createDb(env?.runtimeUrl ?? "", { max: 1 });
      try {
        const claim = {
          scope: "test.create",
          principal: "staff:a",
          key: `k-scope-${run}`,
          requestHash: sha("s"),
        };
        await inTenantTransaction(handle.db, ctx(A.id), async (trx) => {
          await claimIdempotencyKey(trx, ctx(A.id), claim);
          await completeIdempotencyKey(trx, ctx(A.id), claim, { status: 201, body: { n: 3 } });
        });
        await expect(
          inTenantTransaction(handle.db, ctx(A.id), (trx) =>
            claimIdempotencyKey(trx, ctx(A.id), { ...claim, requestHash: sha("d") }),
          ),
        ).rejects.toBeInstanceOf(IdempotencyKeyMismatchError);
        expect(
          await inTenantTransaction(handle.db, ctx(A.id), (trx) =>
            claimIdempotencyKey(trx, ctx(A.id), { ...claim, principal: "staff:other" }),
          ),
        ).toEqual({ kind: "new" });
        expect(
          await inTenantTransaction(handle.db, ctx(B.id), (trx) =>
            claimIdempotencyKey(trx, ctx(B.id), claim),
          ),
        ).toEqual({ kind: "new" });
        await expect(
          inTenantTransaction(handle.db, ctx(A.id), async (trx) => {
            const other = { ...claim, key: `k-error-${run}` };
            await claimIdempotencyKey(trx, ctx(A.id), other);
            await completeIdempotencyKey(trx, ctx(A.id), other, { status: 409, body: {} });
          }),
        ).rejects.toBeInstanceOf(RangeError);
      } finally {
        await handle.end();
      }
    });
  });

  it("commits outbox and audit rows only with their transaction, as JSON objects", async () => {
    const handle = createDb(env?.runtimeUrl ?? "", { max: 1 });
    const marker = `outbox-${run}`;
    const context: TenantContext = { tenantId: A.id, actorType: "system", actorId: "test" };
    try {
      await expect(
        inTenantTransaction(handle.db, context, async (trx) => {
          await enqueueOutbox(trx, context, {
            topic: "test.happened",
            aggregateType: "test",
            aggregateId: marker,
            payload: { marker },
          });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      const [none] =
        await admin`select count(*)::int as n from public.outbox_events where aggregate_id = ${marker}`;
      expect(none?.n).toBe(0);

      await inTenantTransaction(handle.db, context, async (trx) => {
        await enqueueOutbox(trx, context, {
          topic: "test.happened",
          aggregateType: "test",
          aggregateId: marker,
          payload: { marker, nested: { ok: true } },
        });
        await recordAudit(trx, context, {
          action: "test.happened",
          subjectType: "test",
          subjectId: marker,
          reason: "integration test",
          before: null,
          after: { state: "done" },
        });
      });
      const [event] =
        await admin`select payload, jsonb_typeof(payload) as kind from public.outbox_events where aggregate_id = ${marker}`;
      expect(event).toEqual({ payload: { marker, nested: { ok: true } }, kind: "object" });
      const [audit] =
        await admin`select actor_type, actor_id, reason, after_state from public.audit_events where subject_id = ${marker}`;
      expect(audit).toEqual({
        actor_type: "system",
        actor_id: "test",
        reason: "integration test",
        after_state: { state: "done" },
      });
    } finally {
      await handle.end();
    }
  });

  describe("catalog guards", () => {
    it("forces row-level security on every application table", async () => {
      const rows = await admin`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations'`;
      expect(rows.length).toBeGreaterThanOrEqual(10);
      for (const r of rows) {
        expect({ table: r.relname, rls: r.relrowsecurity, forced: r.relforcerowsecurity }).toEqual({
          table: r.relname,
          rls: true,
          forced: true,
        });
      }
    });

    it("gives every tenant_id table a tenant policy on app.current_tenant_id()", async () => {
      const rows = await admin`
        select c.relname,
               bool_or(p.polname = 'tenant_isolation'
                       and pg_get_expr(p.polqual, p.polrelid) like '%current_tenant_id()%'
                       and pg_get_expr(p.polwithcheck, p.polrelid) like '%current_tenant_id()%') as ok
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
          left join pg_policy p on p.polrelid = c.oid
         where n.nspname = 'public' and c.relkind in ('r', 'p')
         group by c.relname`;
      expect(rows.length).toBeGreaterThanOrEqual(5);
      for (const r of rows)
        expect({ table: r.relname, ok: r.ok }).toEqual({ table: r.relname, ok: true });
    });

    it("grants the runtime exactly the intended table and column privileges", async () => {
      const expected: Record<string, string[]> = {
        schema_migrations: ["SELECT"],
        tenants: ["SELECT"],
        tenant_hostnames: ["SELECT"],
        staff_users: [],
        tenant_memberships: ["INSERT", "SELECT"],
        audit_events: ["INSERT", "SELECT"],
        idempotency_keys: ["INSERT", "SELECT"],
        outbox_events: ["INSERT", "SELECT"],
        staff_login_tokens: [],
        staff_sessions: [],
        security_events: [],
        locations: ["INSERT", "SELECT"],
        boats: ["INSERT", "SELECT"],
        products: ["INSERT", "SELECT"],
        product_boats: ["INSERT", "SELECT"],
        schedules: ["INSERT", "SELECT"],
        scheduled_trips: ["INSERT", "SELECT"],
        blackouts: ["INSERT", "SELECT"],
        brand_config_versions: ["INSERT", "SELECT"],
        brand_activations: ["INSERT", "SELECT"],
        // Pricing, policies, and quotes (0005): append-only for the runtime.
        price_list_versions: ["INSERT", "SELECT"],
        price_list_items: ["INSERT", "SELECT"],
        policy_versions: ["INSERT", "SELECT"],
        tax_rate_versions: ["INSERT", "SELECT"],
        promotions: ["INSERT", "SELECT"],
        promotion_versions: ["INSERT", "SELECT"],
        promotion_version_products: ["INSERT", "SELECT"],
        quotes: ["INSERT", "SELECT"],
        quote_lines: ["INSERT", "SELECT"],
        quote_line_taxes: ["INSERT", "SELECT"],
      };
      const rows = await admin`
        select c.relname,
               array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                      where has_table_privilege('tidegrid_app', c.oid, p) order by p) as privileges,
               array(select a.attname::text from pg_attribute a
                      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                        and has_column_privilege('tidegrid_app', c.oid, a.attnum, 'UPDATE')
                      order by a.attname) as update_columns
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p')`;
      const actual = Object.fromEntries(rows.map((r) => [r.relname, r.privileges]));
      expect(actual).toEqual(expected);
      const updates = Object.fromEntries(
        rows.filter((r) => r.update_columns.length > 0).map((r) => [r.relname, r.update_columns]),
      );
      expect(updates).toEqual({
        tenant_memberships: ["display_name", "role", "status", "updated_at"],
        idempotency_keys: ["completed_at", "response_body", "response_status", "status"],
        products: ["sales_status", "updated_at"],
        scheduled_trips: ["sales_state", "sales_state_changed_at", "updated_at"],
      });
      const [identity] = await admin`
        select array(select a.attname::text from pg_attribute a
                      where a.attrelid = 'public.staff_users'::regclass and a.attnum > 0 and not a.attisdropped
                        and has_column_privilege('tidegrid_app', a.attrelid, a.attnum, 'SELECT')
                      order by a.attname) as columns,
               has_database_privilege('tidegrid_app', current_database(), 'TEMP') as temp`;
      expect(identity).toEqual({ columns: ["created_at", "email", "id", "status"], temp: false });
    });

    it("pins search_path and withholds PUBLIC execute on every app function", async () => {
      const rows = await admin`
        select p.proname, p.prosecdef, p.proconfig, p.proacl is null as default_acl,
               exists (select 1 from aclexplode(p.proacl) x where x.grantee = 0) as public_execute,
               pg_get_userbyid(p.proowner) as owner,
               (select r.rolsuper or r.rolbypassrls from pg_roles r where r.oid = p.proowner) as owner_bypasses_rls
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'`;
      expect(rows.length).toBeGreaterThanOrEqual(11);
      for (const r of rows) {
        expect({
          fn: r.proname,
          defaultAcl: r.default_acl,
          publicExecute: r.public_execute,
        }).toEqual({
          fn: r.proname,
          defaultAcl: false,
          publicExecute: false,
        });
        expect(r.owner).not.toBe("tidegrid_app");
        if (r.prosecdef) {
          // Definer functions read tables with forced RLS and no policies; their
          // owner must bypass RLS or every sign-in silently finds nothing.
          expect({
            fn: r.proname,
            config: r.proconfig,
            ownerBypassesRls: r.owner_bypasses_rls,
          }).toEqual({
            fn: r.proname,
            config: ["search_path=pg_catalog, pg_temp"],
            ownerBypassesRls: true,
          });
        }
      }
    });

    it("keeps the membership role constraint equal to the API contract", async () => {
      const [row] = await admin`
        select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
         where c.conrelid = 'public.tenant_memberships'::regclass
           and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%role%'`;
      const roles = [...String(row?.def).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
      expect(roles).toEqual(StaffRole.options);
    });

    it("leaves the runtime role owning nothing", async () => {
      const [row] = await admin`
        select (select count(*)::int from pg_class where relowner = 'tidegrid_app'::regrole)
             + (select count(*)::int from pg_proc where proowner = 'tidegrid_app'::regrole)
             + (select count(*)::int from pg_namespace where nspowner = 'tidegrid_app'::regrole) as n`;
      expect(row?.n).toBe(0);
    });
  });
});
