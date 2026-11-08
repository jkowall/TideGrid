import { randomBytes, randomUUID } from "node:crypto";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { LoginLinkSender } from "../src/auth/login-links.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };

const env = inject("integrationDb");
const CONSOLE = "https://console.test";

/**
 * Tenant access remainder (W3-G2.2b, without managed OIDC and MFA), through
 * the API as the runtime role: invitations, enabling and disabling members
 * with session revocation, TideGrid support access, the data export, and the
 * account deletion request. Two operators throughout; every surface is tried
 * from the other operator's side as well.
 */
describe.skipIf(!env)("tenant access remainder (W3-G2.2b)", () => {
  let admin: Sql;
  const run = randomUUID().slice(0, 8);
  const tenant = (label: string) => ({
    id: randomUUID(),
    slug: `ta-${label}-${run}`,
    name: `Access ${label} ${run}`,
  });
  const A = tenant("a");
  const B = tenant("b");
  const person = (label: string) => ({ id: randomUUID(), email: `${label}-${run}@example.test` });
  const ownerA = person("owner-a");
  const ownerA2 = person("owner-a2");
  const ownerB = person("owner-b");
  const staffA = person("staff-a");
  const financeA = person("finance-a");
  const agent = person("agent");
  const notAgent = person("not-agent");

  const sent: Array<{ email: string; link: string }> = [];
  const captureSender: LoginLinkSender = {
    async send({ email, link }) {
      sent.push({ email, link });
      return {};
    },
  };
  let app: ReturnType<typeof createApp>;
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };
  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
  });

  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; session?: string; key?: string } = {},
  ) {
    const headers = new Headers();
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    if (method !== "GET") headers.set("origin", CONSOLE);
    if (opts.session) headers.set("cookie", `__Host-tg_session=${opts.session}`);
    if (opts.key) headers.set("idempotency-key", opts.key);
    const res = await app.request(
      `http://localhost${path}`,
      { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) },
      bindings(),
      executionCtx,
    );
    await Promise.allSettled(pending.splice(0));
    const text = await res.text();
    return { res, json: (text ? JSON.parse(text) : {}) as Json };
  }

  async function signIn(email: string): Promise<string> {
    const before = sent.length;
    const requested = await call("POST", "/v1/auth/login-links", { body: { email } });
    expect(requested.res.status).toBe(202);
    const link = sent.slice(before).find((s) => s.email === email)?.link;
    if (!link) throw new Error(`no link sent to ${email}`);
    const token = new URL(link).hash.replace("#token=", "");
    const opened = await call("POST", "/v1/auth/sessions", { body: { token } });
    expect(opened.res.status).toBe(201);
    const session = /__Host-tg_session=([A-Za-z0-9_-]{43})/.exec(
      opened.res.headers.get("set-cookie") ?? "",
    )?.[1];
    if (!session) throw new Error("no session cookie");
    return session;
  }

  const sessions: Record<string, string> = {};
  const as = async (p: { email: string }) => {
    sessions[p.email] ??= await signIn(p.email);
    return sessions[p.email] as string;
  };
  const key = () => `key-${randomUUID()}`;
  const members = (t: string) => `/v1/staff/tenants/${t}/members`;
  const status = (t: string, u: string) => `/v1/staff/tenants/${t}/members/${u}/status`;
  const grants = (t: string) => `/v1/staff/tenants/${t}/support-grants`;
  const audit = (t: string) => `/v1/staff/tenants/${t}/audit-events?limit=100`;
  const exportPath = (t: string) => `/v1/staff/tenants/${t}/export`;
  const deletion = (t: string) => `/v1/staff/tenants/${t}/deletion-request`;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    await admin`insert into public.tenants (id, slug, display_name, status) values
      (${A.id}, ${A.slug}, ${A.name}, 'active'),
      (${B.id}, ${B.slug}, ${B.name}, 'active')`;
    for (const p of [ownerA, ownerA2, ownerB, staffA, financeA, agent, notAgent]) {
      await admin`insert into public.staff_users (id, email, display_name)
        values (${p.id}, ${p.email}, ${p.email.split("@")[0] ?? "person"})`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name) values
      (${A.id}, ${ownerA.id}, 'owner', 'Owner A'),
      (${A.id}, ${ownerA2.id}, 'owner', 'Owner A2'),
      (${A.id}, ${staffA.id}, 'booking_staff', 'Staff A'),
      (${A.id}, ${financeA.id}, 'finance', 'Finance A'),
      (${B.id}, ${ownerB.id}, 'owner', 'Owner B')`;
    await admin`insert into public.support_agents (user_id) values (${agent.id})`;
    await admin`insert into public.locations (tenant_id, name, time_zone)
      values (${A.id}, 'Harbor A', 'America/New_York'), (${B.id}, 'Harbor B', 'America/New_York')`;
    app = createApp({ loginLinkSender: captureSender });
  });

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  describe("invitations", () => {
    it("adds a person as invited, with no access until they accept", async () => {
      const invitee = person("invitee");
      const added = await call("POST", members(A.id), {
        session: await as(ownerA),
        key: key(),
        body: {
          email: invitee.email,
          displayName: "New Hand",
          role: "booking_staff",
          reason: "hire",
        },
      });
      expect(added.res.status).toBe(201);
      const member = added.json.member as {
        userId: string;
        status: string;
        invitationExpiresAt: string;
      };
      expect(member.status).toBe("invited");
      const days = (Date.parse(member.invitationExpiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);

      const session = await signIn(invitee.email);
      const me = await call("GET", "/v1/me", { session });
      expect(me.json.memberships).toEqual([]);
      const listed = await call("GET", "/v1/staff/invitations", { session });
      expect(listed.json.invitations).toEqual([
        expect.objectContaining({ tenantId: A.id, tenantSlug: A.slug, role: "booking_staff" }),
      ]);
      // Invited is not a member: the tenant's routes answer as for a stranger.
      const before = await call("GET", `/v1/staff/tenants/${A.id}/catalog`, { session });
      expect(before.res.status).toBe(404);

      // Nobody answers another tenant's invitation, or one they were not sent.
      const wrong = await call("POST", `/v1/staff/invitations/${B.id}/accept`, { session });
      expect(wrong.res.status).toBe(404);
      const stranger = await call("POST", `/v1/staff/invitations/${A.id}/accept`, {
        session: await as(ownerB),
      });
      expect(stranger.res.status).toBe(404);
      const malformed = await call("POST", "/v1/staff/invitations/not-a-uuid/accept", { session });
      expect(malformed.res.status).toBe(404);

      const accepted = await call("POST", `/v1/staff/invitations/${A.id}/accept`, { session });
      expect(accepted.res.status).toBe(200);
      expect(accepted.json).toEqual({ tenantId: A.id, status: "active" });
      const again = await call("POST", `/v1/staff/invitations/${A.id}/accept`, { session });
      expect(again.res.status).toBe(404);
      const after = await call("GET", `/v1/staff/tenants/${A.id}/catalog`, { session });
      expect(after.res.status).toBe(200);
      const meAfter = await call("GET", "/v1/me", { session });
      expect(
        (meAfter.json.memberships as Array<{ tenantId: string }>).map((m) => m.tenantId),
      ).toEqual([A.id]);
      const [event] = await admin`select actor_type, actor_id from public.audit_events
        where tenant_id = ${A.id} and action = 'membership.invitation_accepted' and subject_id = ${member.userId}`;
      expect(event).toEqual({ actor_type: "staff", actor_id: member.userId });
    });

    it("declines, lapses, and sends a lapsed invitation again", async () => {
      const invitee = person("decliner");
      const added = await call("POST", members(A.id), {
        session: await as(ownerA),
        key: key(),
        body: { email: invitee.email, displayName: "Maybe", role: "finance", reason: "seasonal" },
      });
      const userId = (added.json.member as { userId: string }).userId;
      const session = await signIn(invitee.email);
      const declined = await call("POST", `/v1/staff/invitations/${A.id}/decline`, { session });
      expect(declined.json).toEqual({ tenantId: A.id, status: "disabled" });

      // The owner sends it again; it lapses; the owner sends it once more.
      const again = await call("POST", status(A.id, userId), {
        session: await as(ownerA),
        key: key(),
        body: { status: "active", reason: "asked again" },
      });
      expect(again.res.status).toBe(200);
      expect((again.json.member as { status: string }).status).toBe("invited");
      await admin`update public.tenant_memberships
        set invited_at = now() - interval '8 days', invitation_expires_at = now() - interval '1 day'
        where tenant_id = ${A.id} and user_id = ${userId}`;
      const lapsed = await call("GET", "/v1/staff/invitations", { session });
      expect(lapsed.json.invitations).toEqual([]);
      expect(
        (await call("POST", `/v1/staff/invitations/${A.id}/accept`, { session })).res.status,
      ).toBe(404);
      const fresh = await call("POST", status(A.id, userId), {
        session: await as(ownerA),
        key: key(),
        body: { status: "active", reason: "one more time" },
      });
      const expires = (fresh.json.member as { invitationExpiresAt: string }).invitationExpiresAt;
      expect(Date.parse(expires)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      expect(
        (await call("POST", `/v1/staff/invitations/${A.id}/accept`, { session })).res.status,
      ).toBe(200);
    });

    it("never lets the runtime activate an invitation directly", async () => {
      const invitee = person("direct");
      const added = await call("POST", members(A.id), {
        session: await as(ownerA),
        key: key(),
        body: { email: invitee.email, displayName: "Direct", role: "owner", reason: "test" },
      });
      const userId = (added.json.member as { userId: string }).userId;
      const runtime = postgres(env?.runtimeUrl ?? "", { max: 1, onnotice: () => {} });
      try {
        const attempt = runtime.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${A.id}, true),
                          set_config('app.actor_type', 'staff', true),
                          set_config('app.actor_id', ${ownerA.id}, true)`;
          await tx`update public.tenant_memberships set status = 'active'
                    where tenant_id = ${A.id} and user_id = ${userId}`;
        });
        await expect(attempt).rejects.toMatchObject({ code: "42501" });
        // A runtime insert is an invitation whatever it names.
        const other = person("forced");
        await admin`insert into public.staff_users (id, email, display_name)
          values (${other.id}, ${other.email}, 'forced')`;
        const [row] = await runtime.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${A.id}, true),
                          set_config('app.actor_type', 'staff', true),
                          set_config('app.actor_id', ${ownerA.id}, true)`;
          return tx`insert into public.tenant_memberships (tenant_id, user_id, role, status, display_name)
            values (${A.id}, ${other.id}, 'owner', 'active', 'Forced')
            returning status, invited_by, accepted_at`;
        });
        expect(row).toEqual({ status: "invited", invited_by: ownerA.id, accepted_at: null });
      } finally {
        await runtime.end({ timeout: 5 });
      }
    });
  });

  describe("disabling a member", () => {
    it("ends access and revokes the sessions of a member who accepted", async () => {
      const session = await signIn(staffA.email);
      expect((await call("GET", "/v1/me", { session })).res.status).toBe(200);
      const disabled = await call("POST", status(A.id, staffA.id), {
        session: await as(ownerA),
        key: key(),
        body: { status: "disabled", reason: "left the company" },
      });
      expect(disabled.res.status).toBe(200);
      expect((disabled.json.member as { status: string }).status).toBe("disabled");
      expect((await call("GET", "/v1/me", { session })).res.status).toBe(401);
      const [event] = await admin`select count(*)::int as n from public.security_events
        where kind = 'sessions_revoked_on_disable' and user_id = ${staffA.id}`;
      expect(event?.n).toBeGreaterThanOrEqual(1);

      // Enabling again does not revive the old session.
      const enabled = await call("POST", status(A.id, staffA.id), {
        session: await as(ownerA),
        key: key(),
        body: { status: "active", reason: "came back" },
      });
      expect((enabled.json.member as { status: string }).status).toBe("active");
      expect((await call("GET", "/v1/me", { session })).res.status).toBe(401);
      const audit = await admin`select reason, before_state, after_state from public.audit_events
        where tenant_id = ${A.id} and action = 'membership.status_changed' and subject_id = ${staffA.id}
        order by id`;
      expect(audit.map((r) => r.reason)).toEqual(["left the company", "came back"]);
    });

    it("keeps a person signed in for another operator, and signs out a disabled identity", async () => {
      const both = person("both");
      await admin`insert into public.staff_users (id, email, display_name)
        values (${both.id}, ${both.email}, 'both')`;
      await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name) values
        (${A.id}, ${both.id}, 'finance', 'Both A'), (${B.id}, ${both.id}, 'finance', 'Both B')`;
      const session = await signIn(both.email);
      await call("POST", status(A.id, both.id), {
        session: await as(ownerA),
        key: key(),
        body: { status: "disabled", reason: "A only" },
      });
      const me = await call("GET", "/v1/me", { session });
      expect((me.json.memberships as Array<{ tenantId: string }>).map((m) => m.tenantId)).toEqual([
        B.id,
      ]);
      // Disabling the identity itself (an owner-run step) signs them out.
      await admin`update public.staff_users set status = 'disabled' where id = ${both.id}`;
      await admin`update public.staff_users set status = 'active' where id = ${both.id}`;
      expect((await call("GET", "/v1/me", { session })).res.status).toBe(401);
    });

    it("revokes, on re-enable, a session that raced the identity's disable", async () => {
      const raced = person("raced");
      await admin`insert into public.staff_users (id, email, display_name, status)
        values (${raced.id}, ${raced.email}, 'raced', 'disabled')`;
      // A sign-in that committed just after the disable: a session row for a
      // disabled identity, which resolves to nothing while it stays disabled.
      const hash = randomBytes(32).toString("hex");
      await admin`insert into public.staff_sessions (session_hash, user_id, auth_method, expires_at)
        values (${hash}, ${raced.id}, 'magic_link', now() + interval '1 hour')`;
      await admin`update public.staff_users set status = 'active' where id = ${raced.id}`;
      const [row] = await admin`select revoked_at is not null as revoked
        from public.staff_sessions where session_hash = ${hash}`;
      expect(row).toEqual({ revoked: true });
    });

    it("signs a person out when their last two memberships are disabled at once", async () => {
      const pair = person("pair");
      await admin`insert into public.staff_users (id, email, display_name)
        values (${pair.id}, ${pair.email}, 'pair')`;
      await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name) values
        (${A.id}, ${pair.id}, 'finance', 'Pair A'), (${B.id}, ${pair.id}, 'finance', 'Pair B')`;
      const session = await signIn(pair.email);
      const runtime = postgres(env?.runtimeUrl ?? "", { max: 2, onnotice: () => {} });
      try {
        // Different rows in different tenants, so no row lock orders them:
        // each stays open a moment after its update, as two owners at once.
        const disable = (tenantId: string, actor: string) =>
          runtime.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true),
                            set_config('app.actor_type', 'staff', true),
                            set_config('app.actor_id', ${actor}, true)`;
            await tx`update public.tenant_memberships set status = 'disabled'
                      where tenant_id = ${tenantId} and user_id = ${pair.id}`;
            await tx`select pg_sleep(0.3)`;
          });
        await Promise.all([disable(A.id, ownerA.id), disable(B.id, ownerB.id)]);
      } finally {
        await runtime.end({ timeout: 5 });
      }
      expect((await call("GET", "/v1/me", { session })).res.status).toBe(401);
    });

    it("withdraws an invitation without signing a stranger out", async () => {
      const stranger = person("stranger");
      const session = await signIn(
        await (async () => {
          await admin`insert into public.staff_users (id, email, display_name)
            values (${stranger.id}, ${stranger.email}, 'stranger')`;
          await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
            values (${B.id}, ${stranger.id}, 'finance', 'Stranger')`;
          return stranger.email;
        })(),
      );
      await call("POST", members(A.id), {
        session: await as(ownerA),
        key: key(),
        body: { email: stranger.email, displayName: "Stranger", role: "finance", reason: "x" },
      });
      const withdrawn = await call("POST", status(A.id, stranger.id), {
        session: await as(ownerA),
        key: key(),
        body: { status: "disabled", reason: "sent by mistake" },
      });
      expect((withdrawn.json.member as { status: string }).status).toBe("disabled");
      expect((await call("GET", "/v1/me", { session })).res.status).toBe(200);
    });

    it("refuses your own status, other roles, and other tenants' members", async () => {
      const self = await call("POST", status(A.id, ownerA.id), {
        session: await as(ownerA),
        key: key(),
        body: { status: "disabled", reason: "x" },
      });
      expect(self.json.error?.code).toBe("member_self");
      const finance = await call("POST", status(A.id, staffA.id), {
        session: await as(financeA),
        key: key(),
        body: { status: "disabled", reason: "x" },
      });
      expect(finance.res.status).toBe(403);
      // A member of B only, named through A: no such member here.
      const foreign = await call("POST", status(A.id, ownerB.id), {
        session: await as(ownerA),
        key: key(),
        body: { status: "disabled", reason: "x" },
      });
      expect(foreign.json.error?.code).toBe("member_not_found");
      // A's owner on B's route: B does not exist for them.
      const crossed = await call("POST", status(B.id, ownerB.id), {
        session: await as(ownerA),
        key: key(),
        body: { status: "disabled", reason: "x" },
      });
      expect(crossed.res.status).toBe(404);
      expect(crossed.json.error?.code).toBe("tenant_not_found");
      const [b] = await admin`select status from public.tenant_memberships
        where tenant_id = ${B.id} and user_id = ${ownerB.id}`;
      expect(b?.status).toBe("active");
    });

    it("keeps the last active owner in the database, whoever writes", async () => {
      const runtime = postgres(env?.runtimeUrl ?? "", { max: 1, onnotice: () => {} });
      try {
        const attempt = runtime.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${B.id}, true)`;
          await tx`update public.tenant_memberships set role = 'finance'
                    where tenant_id = ${B.id} and user_id = ${ownerB.id}`;
        });
        await expect(attempt).rejects.toMatchObject({
          code: "23514",
          constraint_name: "tenant_memberships_last_owner",
        });
      } finally {
        await runtime.end({ timeout: 5 });
      }
    });
  });

  describe("support access", () => {
    it("lets an agent in only through an owner's open grant, read-only and masked", async () => {
      const agentSession = await as(agent);
      expect((await call("GET", audit(A.id), { session: agentSession })).res.status).toBe(404);

      const finance = await call("POST", grants(A.id), {
        session: await as(financeA),
        key: key(),
        body: { agentEmail: agent.email, reason: "x", minutes: 60 },
      });
      expect(finance.res.status).toBe(403);
      const tooLong = await call("POST", grants(A.id), {
        session: await as(ownerA),
        key: key(),
        body: { agentEmail: agent.email, reason: "x", minutes: 241 },
      });
      expect(tooLong.res.status).toBe(400);
      const unknown = await call("POST", grants(A.id), {
        session: await as(ownerA),
        key: key(),
        body: { agentEmail: notAgent.email, reason: "x", minutes: 60 },
      });
      expect(unknown.json.error?.code).toBe("support_agent_not_found");

      const granted = await call("POST", grants(A.id), {
        session: await as(ownerA),
        key: key(),
        body: { agentEmail: agent.email, reason: "Ticket 42: refund question", minutes: 60 },
      });
      expect(granted.res.status).toBe(201);
      const grant = granted.json.grant as {
        id: string;
        state: string;
        revealPersonalData: boolean;
      };
      expect(grant).toMatchObject({ state: "open", revealPersonalData: false });
      const twice = await call("POST", grants(A.id), {
        session: await as(ownerA),
        key: key(),
        body: { agentEmail: agent.email, reason: "again", minutes: 60 },
      });
      expect(twice.json.error?.code).toBe("support_grant_open");

      // Masked: audit and catalog, not the staff list; never a command.
      const read = await call("GET", audit(A.id), { session: agentSession });
      expect(read.res.status).toBe(200);
      expect(
        (await call("GET", `/v1/staff/tenants/${A.id}/catalog`, { session: agentSession })).res
          .status,
      ).toBe(200);
      expect((await call("GET", members(A.id), { session: agentSession })).res.status).toBe(403);
      const command = await call("POST", members(A.id), {
        session: agentSession,
        key: key(),
        body: { email: `x-${run}@example.test`, displayName: "X", role: "owner", reason: "x" },
      });
      expect(command.res.status).toBe(403);
      for (const path of [exportPath(A.id), deletion(A.id), grants(A.id)]) {
        expect({
          path,
          status: (await call("GET", path, { session: agentSession })).res.status,
        }).toEqual({
          path,
          status: 403,
        });
      }
      // The grant is for A only.
      expect((await call("GET", audit(B.id), { session: agentSession })).res.status).toBe(404);

      // Every request it made is in A's history, as support, with the grant's
      // reason: the two it was allowed and the five it was refused.
      const used =
        await admin`select actor_type, actor_id, reason, after_state from public.audit_events
        where tenant_id = ${A.id} and action = 'support_access.used' and subject_id = ${grant.id}
        order by occurred_at, id`;
      expect(used.length).toBe(7);
      expect(used[0]).toMatchObject({
        actor_type: "support",
        actor_id: agent.id,
        reason: "Ticket 42: refund question",
        after_state: { method: "GET", masked: true, permission: "audit.read", allowed: true },
      });
      expect(
        used.filter((u) => (u.after_state as { allowed: boolean }).allowed === false),
      ).toHaveLength(5);
      // B's owner sees none of A's grants.
      const bList = await call("GET", grants(B.id), { session: await as(ownerB) });
      expect(bList.json.grants).toEqual([]);

      const revoked = await call("POST", `${grants(A.id)}/${grant.id}/revoke`, {
        session: await as(ownerA),
        key: key(),
        body: { reason: "done" },
      });
      expect((revoked.json.grant as { state: string }).state).toBe("revoked");
      expect((await call("GET", audit(A.id), { session: agentSession })).res.status).toBe(404);
      const revokedAgain = await call("POST", `${grants(A.id)}/${grant.id}/revoke`, {
        session: await as(ownerA),
        key: key(),
        body: { reason: "done" },
      });
      expect(revokedAgain.res.status).toBe(404);
      // B's owner cannot revoke A's grant through B.
      const foreign = await call("POST", `${grants(B.id)}/${grant.id}/revoke`, {
        session: await as(ownerB),
        key: key(),
        body: { reason: "x" },
      });
      expect(foreign.json.error?.code).toBe("support_grant_not_found");
    });

    it("reveals personal data only when the owner chose it, and ends with the grant's window", async () => {
      const agentSession = await as(agent);
      const granted = await call("POST", grants(A.id), {
        session: await as(ownerA),
        key: key(),
        body: {
          agentEmail: agent.email,
          reason: "Ticket 43",
          minutes: 15,
          revealPersonalData: true,
        },
      });
      expect(granted.res.status).toBe(201);
      const grantId = (granted.json.grant as { id: string }).id;
      expect((await call("GET", members(A.id), { session: agentSession })).res.status).toBe(200);
      // Still read-only.
      const write = await call("POST", status(A.id, staffA.id), {
        session: agentSession,
        key: key(),
        body: { status: "disabled", reason: "x" },
      });
      expect(write.res.status).toBe(403);

      // A grant past its window lets nothing in. The window is checked when
      // it is written, so an expired one is made in the past.
      await admin`update public.support_access_grants set revoked_at = now(), revoked_by = ${ownerA.id}
        where id = ${grantId}`;
      await admin`insert into public.support_access_grants
          (tenant_id, agent_user_id, granted_by, reason, granted_at, expires_at)
        values (${A.id}, ${agent.id}, ${ownerA.id}, 'old', now() - interval '3 hours', now() - interval '1 hour')`;
      expect((await call("GET", audit(A.id), { session: agentSession })).res.status).toBe(404);
    });

    it("grants the full four hours, and revokes an old grant by id", async () => {
      const granted = await call("POST", grants(B.id), {
        session: await as(ownerB),
        key: key(),
        body: { agentEmail: agent.email, reason: "Ticket 44", minutes: 240 },
      });
      expect(granted.res.status).toBe(201);
      const grant = granted.json.grant as { id: string; grantedAt: string; expiresAt: string };
      expect(Date.parse(grant.expiresAt) - Date.parse(grant.grantedAt)).toBe(4 * 60 * 60 * 1000);
      // Push it behind 250 newer (revoked) grants: the revocation finds it by id.
      await admin`insert into public.support_access_grants
          (tenant_id, agent_user_id, granted_by, reason, granted_at, expires_at, revoked_at, revoked_by)
        select ${B.id}, ${agent.id}, ${ownerB.id}, 'old',
               now() + make_interval(secs => i), now() + make_interval(secs => i + 60),
               now() + make_interval(secs => i + 1), ${ownerB.id}
          from generate_series(1, 250) i`;
      const revoked = await call("POST", `${grants(B.id)}/${grant.id}/revoke`, {
        session: await as(ownerB),
        key: key(),
        body: { reason: "done" },
      });
      expect(revoked.res.status).toBe(200);
      expect((revoked.json.grant as { state: string }).state).toBe("revoked");
    });

    it("keeps grants out of the runtime's reach and immutable but for one revocation", async () => {
      const runtime = postgres(env?.runtimeUrl ?? "", { max: 1, onnotice: () => {} });
      try {
        const read = runtime.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${A.id}, true)`;
          return tx`select * from public.support_access_grants`;
        });
        await expect(read).rejects.toMatchObject({ code: "42501" });
        // A runtime caller that is not an owner of the context tenant is refused.
        const issue = runtime.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${A.id}, true),
                          set_config('app.actor_type', 'staff', true),
                          set_config('app.actor_id', ${staffA.id}, true)`;
          return tx`select * from app.support_grant_issue(${agent.email}, 'x', 60, true, null)`;
        });
        await expect(issue).rejects.toMatchObject({ code: "42501" });
        const crossed = runtime.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${B.id}, true),
                          set_config('app.actor_type', 'staff', true),
                          set_config('app.actor_id', ${ownerA.id}, true)`;
          return tx`select * from app.support_grant_issue(${agent.email}, 'x', 60, true, null)`;
        });
        await expect(crossed).rejects.toMatchObject({ code: "42501" });
      } finally {
        await runtime.end({ timeout: 5 });
      }
      const [grant] = await admin`select id from public.support_access_grants
        where tenant_id = ${A.id} limit 1`;
      await expect(
        admin`update public.support_access_grants set reason = 'changed' where id = ${grant?.id}`,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        admin`delete from public.support_access_grants where id = ${grant?.id}`,
      ).rejects.toMatchObject({ code: "55000" });
    });
  });

  describe("data export", () => {
    it("exports only the owner's own tenant, records it first, and leaves secrets out", async () => {
      const done = await call("GET", exportPath(A.id), { session: await as(ownerA) });
      expect(done.res.status).toBe(200);
      expect(done.res.headers.get("content-disposition")).toBe(
        `attachment; filename="tidegrid-export-${A.slug}.json"`,
      );
      expect(done.res.headers.get("cache-control")).toBe("no-store");
      const body = done.json as {
        format: string;
        tenant: { id: string };
        sections: Record<string, { rows: Array<Record<string, unknown>>; truncated: boolean }>;
      };
      expect(body.format).toBe("tidegrid.tenant-export.v1");
      expect(body.tenant.id).toBe(A.id);
      expect(body.sections.locations?.rows.map((r) => r.name)).toEqual(["Harbor A"]);
      expect(body.sections.members?.rows.map((r) => r.userId)).toContain(ownerA.id);
      const text = JSON.stringify(body);
      for (const foreign of [B.id, ownerB.email, "Harbor B"]) expect(text).not.toContain(foreign);
      for (const section of Object.values(body.sections)) {
        for (const row of section.rows) {
          for (const column of Object.keys(row)) {
            expect(column).not.toMatch(/hash|secret|token|idempotency_key|client_key|source_ip/);
          }
        }
      }
      const [event] = await admin`select count(*)::int as n from public.audit_events
        where tenant_id = ${A.id} and action = 'tenant.data_exported' and actor_id = ${ownerA.id}`;
      expect(event?.n).toBe(1);

      expect(
        (await call("GET", exportPath(A.id), { session: await as(financeA) })).res.status,
      ).toBe(403);
      expect((await call("GET", exportPath(B.id), { session: await as(ownerA) })).res.status).toBe(
        404,
      );
    });
  });

  describe("account deletion request", () => {
    it("records, refuses a second, withdraws, and stays inside its tenant", async () => {
      const owner = await as(ownerA);
      expect((await call("GET", deletion(A.id), { session: owner })).json).toEqual({
        request: null,
      });
      const wrong = await call("POST", deletion(A.id), {
        session: owner,
        key: key(),
        body: { reason: "closing", confirmSlug: B.slug },
      });
      expect(wrong.json.error?.code).toBe("deletion_slug_mismatch");
      const made = await call("POST", deletion(A.id), {
        session: owner,
        key: key(),
        body: { reason: "closing the business", confirmSlug: A.slug.toUpperCase() },
      });
      expect(made.res.status).toBe(201);
      const request = made.json.request as { id: string; state: string; requestedBy: string };
      expect(request).toMatchObject({ state: "requested", requestedBy: ownerA.id });
      const twice = await call("POST", deletion(A.id), {
        session: owner,
        key: key(),
        body: { reason: "again", confirmSlug: A.slug },
      });
      expect(twice.json.error?.code).toBe("deletion_request_open");
      const [outbox] = await admin`select count(*)::int as n from public.outbox_events
        where tenant_id = ${A.id} and topic = 'tenant.deletion.requested'`;
      expect(outbox?.n).toBe(1);

      // B sees nothing of A's request, and cannot reach it.
      expect((await call("GET", deletion(B.id), { session: await as(ownerB) })).json).toEqual({
        request: null,
      });
      const crossed = await call("POST", `${deletion(A.id)}/withdraw`, {
        session: await as(ownerB),
        key: key(),
        body: { reason: "x" },
      });
      expect(crossed.res.status).toBe(404);
      expect(
        (await call("GET", deletion(A.id), { session: await as(staffA) })).res.status,
      ).not.toBe(200);

      const withdrawn = await call("POST", `${deletion(A.id)}/withdraw`, {
        session: owner,
        key: key(),
        body: { reason: "changed our mind" },
      });
      expect(withdrawn.res.status).toBe(200);
      expect(withdrawn.json.request).toMatchObject({ state: "withdrawn", withdrawnBy: ownerA.id });
      expect((await call("GET", deletion(A.id), { session: owner })).json).toEqual({
        request: null,
      });
      await expect(
        admin`update public.tenant_deletion_requests set state = 'requested' where id = ${request.id}`,
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
