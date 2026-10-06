/**
 * G2.15 core: templates, assignment, delivery generations, token redemption,
 * signing, evidence, revocation, and a version change, against PostgreSQL as
 * tidegrid_app. Bookings come from the real checkout; participants and mail
 * go through the in-memory ports.
 */
import { createHash } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  assignBookingWaivers,
  getSigningView,
  loadWaiverSession,
  publishWaiverTemplateVersion,
  redeemWaiverToken,
  revokeParticipantWaivers,
  type SignInput,
  sendWaiverRequest,
  signWaiver,
  type WaiverDeps,
  type WaiverSession,
  waiverContentSha256,
} from "./index.ts";
import {
  type Booked,
  bookParty,
  createWaiverFixture,
  FIXTURE_TEXT,
  fixtureDeps,
  MemoryDirectory,
  participant,
  RecordingMailer,
  staffContext,
  tokenOf,
  type WaiverFixture,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;
const env = inject("integrationDb");

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return e.constraint_name ? `${e.code}:${e.constraint_name}` : (e.code ?? "no-code");
  }
  return "no-error";
}

describe.skipIf(!env)("G2.15 waiver evidence core", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: WaiverFixture;
  let B: WaiverFixture;
  const directory = new MemoryDirectory();
  const mailer = new RecordingMailer();
  let deps: WaiverDeps;
  let tripIndex = 0;

  const guest = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "guest",
    actorId: null,
    requestId: `guest-${Math.random()}`,
    sourceIp: "203.0.113.9",
  });

  function inTenant<T>(ctx: TenantContext, fn: Parameters<typeof inTenantTransaction<T>>[2]) {
    return inTenantTransaction(runtime.db, ctx, fn);
  }

  async function book(t: WaiverFixture, party = 2): Promise<Booked> {
    const tripId = t.trips.shared[tripIndex++];
    if (!tripId) throw new Error("out of fixture trips");
    return bookParty(admin, runtime.db, t, tripId, party);
  }

  async function assign(t: WaiverFixture, bookingId: string, participantIds?: string[]) {
    const ctx = staffContext(t.id, "confirmation");
    return inTenant(ctx, (trx) =>
      assignBookingWaivers(trx, ctx, deps, {
        bookingId,
        ...(participantIds ? { participantIds } : {}),
      }),
    );
  }

  async function redeem(tenantId: string, token: string) {
    const ctx = guest(tenantId);
    return inTenant(ctx, (trx) => redeemWaiverToken(trx, ctx, { token }));
  }

  async function open(
    tenantId: string,
    requestId: string,
  ): Promise<{ session: WaiverSession; secret: string }> {
    const opened = await redeem(tenantId, tokenOf(mailer.lastFor(requestId).link));
    if (opened.kind !== "opened") throw new Error(`redeem: ${JSON.stringify(opened)}`);
    return { session: opened.session, secret: opened.secret };
  }

  async function sign(tenantId: string, session: WaiverSession, input: Partial<SignInput> = {}) {
    const ctx = guest(tenantId);
    return inTenant(ctx, async (trx) => {
      const view = await getSigningView(trx, tenantId, deps, session);
      return signWaiver(
        trx,
        ctx,
        deps,
        session,
        {
          contentSha256: view.waiver.contentSha256,
          acknowledgments: view.waiver.acknowledgments.map(() => true),
          consent: true,
          confirmIdentity: true,
          signature: view.participant?.name ?? "",
          relationship: null,
          ...input,
        },
        { sourceIp: "203.0.113.9", userAgent: "vitest" },
      );
    });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    deps = fixtureDeps(directory, mailer);
    A = await createWaiverFixture(admin, runtime.db, "wv-a");
    B = await createWaiverFixture(admin, runtime.db, "wv-b");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("stores each version's hash from its canonical content, and never edits a version", async () => {
    const [version] = await admin<
      { content_sha256: string; effective_from: Date; created_at: Date }[]
    >`
      select content_sha256, effective_from, created_at from public.waiver_template_versions
       where tenant_id = ${A.id} and template_id = ${A.templateId} and version = 1`;
    expect(version?.content_sha256).toBe(await waiverContentSha256(FIXTURE_TEXT));
    // A version takes effect no earlier than it was written.
    expect(version?.effective_from.getTime()).toBeGreaterThanOrEqual(
      (version?.created_at.getTime() ?? 0) - 1000,
    );
    expect(
      await pgError(
        admin`update public.waiver_template_versions set title = 'x' where tenant_id = ${A.id}`,
      ),
    ).toBe("55000");
    expect(
      await pgError(admin`delete from public.waiver_template_versions where tenant_id = ${A.id}`),
    ).toBe("55000");
  });

  it("assigns one request per participant, with the signer a minor needs, and sends each once", async () => {
    const booked = await book(A, 3);
    const [adult, minor, noEmail] = directory.set(booked.bookingId, [
      participant("Ada Adult"),
      participant("Milo Minor", { minor: true, email: "parent.of.milo@example.test" }),
      participant("Nora Noemail", { email: null }),
    ]);
    const first = await assign(A, booked.bookingId);
    expect(first.required).toBe(true);
    expect(first.created.map((c) => [c.participantId, c.requiredSigner, c.delivery.kind])).toEqual([
      [adult?.id, "participant", "sent"],
      [minor?.id, "guardian", "sent"],
      [noEmail?.id, "participant", "no_address"],
    ]);
    const minorRequest = first.created[1]?.requestId ?? "";
    const message = mailer.lastFor(minorRequest);
    expect(message).toMatchObject({
      idempotencyKey: `waiver:${minorRequest}:1`,
      to: "parent.of.milo@example.test",
      requiredSigner: "guardian",
      participantName: "Milo Minor",
    });
    expect(message.link.startsWith("https://waivers.book.example.test/waiver#t=")).toBe(true);

    // A retry, or a later call for the same people, creates and sends nothing.
    const sentBefore = mailer.sent.length;
    const again = await assign(A, booked.bookingId);
    expect(again.created).toEqual([]);
    expect(again.alreadyAssigned).toBe(3);
    expect(mailer.sent.length).toBe(sentBefore);
    const rows =
      await admin`select count(*)::int as n from public.waiver_requests where booking_id = ${booked.bookingId}`;
    expect(rows[0]?.n).toBe(3);

    // Only the hash of a token is stored.
    const token = tokenOf(message.link);
    const stored = await admin<{ token_hash: string }[]>`
      select token_hash from public.waiver_access_tokens where request_id = ${minorRequest}`;
    expect(stored.map((s) => s.token_hash)).toEqual([
      createHash("sha256").update(`waiver-token:${token}`).digest("hex"),
    ]);
  });

  it("never assigns twice when confirmation and a participant addition race", async () => {
    const booked = await book(A, 2);
    directory.set(booked.bookingId, [participant("Rae One"), participant("Rae Two")]);
    const results = await Promise.all([
      assign(A, booked.bookingId),
      assign(A, booked.bookingId),
      assign(A, booked.bookingId),
    ]);
    expect(results.reduce((n, r) => n + r.created.length, 0)).toBe(2);
    const [row] = await admin<{ requests: number; deliveries: number }[]>`
      select (select count(*)::int from public.waiver_requests where booking_id = ${booked.bookingId}) as requests,
             (select count(*)::int from public.waiver_deliveries d join public.waiver_requests r on r.id = d.request_id
               where r.booking_id = ${booked.bookingId}) as deliveries`;
    expect(row).toEqual({ requests: 2, deliveries: 2 });
  });

  it("redeems a token once, by POST only, into a session bound to its request", async () => {
    const booked = await book(A, 1);
    const [p] = directory.set(booked.bookingId, [participant("Sol Signer")]);
    const assigned = await assign(A, booked.bookingId);
    const requestId = assigned.created[0]?.requestId ?? "";
    const token = tokenOf(mailer.lastFor(requestId).link);

    // Another tenant's origin finds nothing.
    expect((await redeem(B.id, token)).kind).toBe("invalid");
    const opened = await redeem(A.id, token);
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;
    expect(opened.session).toMatchObject({
      requestId,
      bookingId: booked.bookingId,
      participantId: p?.id,
      signerRole: "participant",
    });
    // Replay.
    expect((await redeem(A.id, token)).kind).toBe("used");
    // The session secret works only in its own tenant.
    const found = await inTenant(guest(A.id), (trx) => loadWaiverSession(trx, A.id, opened.secret));
    expect(found?.id).toBe(opened.session.id);
    expect(
      await inTenant(guest(B.id), (trx) => loadWaiverSession(trx, B.id, opened.secret)),
    ).toBeNull();
    // The database refuses a second session for the token, and a session without a fresh redemption.
    expect(
      await pgError(admin`
        insert into public.waiver_signing_sessions (tenant_id, token_id, request_id, booking_id,
          participant_id, purpose, signer_role, secret_hash, expires_at)
        select tenant_id, token_id, request_id, booking_id, participant_id, purpose, signer_role,
               repeat('a', 64), now() + interval '5 minutes'
          from public.waiver_signing_sessions where id = ${opened.session.id}`),
    ).toMatch(/^23(505|514)/);
  });

  it("signs once with every acknowledgment and the booking's name, and keeps the PDF with its hash", async () => {
    const booked = await book(A, 1);
    directory.set(booked.bookingId, [participant("Zoë Example")]);
    const assigned = await assign(A, booked.bookingId);
    const requestId = assigned.created[0]?.requestId ?? "";
    const { session } = await open(A.id, requestId);

    const refused = await sign(A.id, session, { signature: "Someone Else" });
    expect(refused.kind).toBe("invalid");
    expect(refused.kind === "invalid" && refused.problems.map((p) => p.code)).toEqual([
      "does_not_match",
    ]);
    expect((await sign(A.id, session, { acknowledgments: [true, false] })).kind).toBe("invalid");
    expect((await sign(A.id, session, { contentSha256: "0".repeat(64) })).kind).toBe(
      "content_changed",
    );

    const signed = await sign(A.id, session, { signature: "  zoë   EXAMPLE " });
    expect(signed.kind).toBe("signed");
    if (signed.kind !== "signed") return;
    expect(signed.view.state).toBe("signed");
    expect(signed.view.signed?.signerName).toBe("Zoë Example");

    const [evidence] = await admin<
      {
        document: Buffer;
        document_sha256: string;
        signature_text: string;
        content_sha256: string;
        source_ip: string;
        recipient_email: string;
      }[]
    >`select document, document_sha256, signature_text, content_sha256, source_ip, recipient_email
        from public.waiver_evidence where request_id = ${requestId}`;
    expect(evidence?.document_sha256).toBe(
      createHash("sha256")
        .update(evidence?.document ?? "")
        .digest("hex"),
    );
    expect(evidence?.document.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(evidence?.signature_text).toBe("zoë EXAMPLE");
    expect(evidence?.content_sha256).toBe(await waiverContentSha256(FIXTURE_TEXT));
    expect(evidence?.recipient_email).toBe("zo.example@example.test");

    // The same session again returns the same evidence; nothing new is written.
    const again = await sign(A.id, session);
    expect(again.kind).toBe("already_signed");
    expect(again.kind === "already_signed" && again.view.signed?.evidenceId).toBe(
      signed.view.signed?.evidenceId,
    );

    // Evidence never changes and never goes away, for any role; the request never returns to pending.
    for (const statement of [
      admin`update public.waiver_evidence set signer_name = 'x' where request_id = ${requestId}`,
      admin`delete from public.waiver_evidence where request_id = ${requestId}`,
      admin`update public.waiver_requests set state = 'pending' where id = ${requestId}`,
    ]) {
      expect(await pgError(statement)).toMatch(/^(55000|23514)/);
    }
    const runtimeSql = postgres(env?.runtimeUrl ?? "", { max: 1, onnotice: () => {} });
    try {
      const attempt = runtimeSql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${A.id}, true)`;
        await tx`update public.waiver_evidence set signer_name = 'x' where request_id = ${requestId}`;
      });
      expect(await pgError(attempt)).toBe("42501");
    } finally {
      await runtimeSql.end({ timeout: 5 });
    }
  });

  it("lets a parent or guardian sign for a minor, with the relationship declared", async () => {
    const booked = await book(A, 2);
    const [, kid] = directory.set(booked.bookingId, [
      participant("Gail Guardian"),
      participant("Kit Minor", { minor: true, email: "gail.guardian@example.test" }),
    ]);
    const assigned = await assign(A, booked.bookingId);
    const kidRequest = assigned.created.find((c) => c.participantId === kid?.id)?.requestId ?? "";
    const { session } = await open(A.id, kidRequest);
    expect(session.signerRole).toBe("guardian");
    expect((await sign(A.id, session, { signature: "Gail Guardian" })).kind).toBe("invalid");
    const signed = await sign(A.id, session, {
      signature: "Gail Guardian",
      relationship: "parent",
    });
    expect(signed.kind).toBe("signed");
    const [row] = await admin<
      {
        signer_role: string;
        signer_name: string;
        guardian_relationship: string;
        participant_minor: boolean;
      }[]
    >`
      select signer_role, signer_name, guardian_relationship, participant_minor
        from public.waiver_evidence where request_id = ${kidRequest}`;
    expect(row).toEqual({
      signer_role: "guardian",
      signer_name: "Gail Guardian",
      guardian_relationship: "parent",
      participant_minor: true,
    });
  });

  it("revokes a removed participant's request, links, and session", async () => {
    const booked = await book(A, 2);
    const [stay, leave] = directory.set(booked.bookingId, [
      participant("Stay Here"),
      participant("Lee Leaving"),
    ]);
    const assigned = await assign(A, booked.bookingId);
    const leaveRequest =
      assigned.created.find((c) => c.participantId === leave?.id)?.requestId ?? "";
    const { session, secret } = await open(A.id, leaveRequest);
    directory.remove(booked.bookingId, leave?.id ?? "");
    const ctx = staffContext(A.id, "participant-removal");
    const revoked = await inTenant(ctx, (trx) =>
      revokeParticipantWaivers(trx, ctx, {
        bookingId: booked.bookingId,
        participantId: leave?.id ?? "",
      }),
    );
    expect(revoked.revoked).toBe(1);
    expect(await inTenant(guest(A.id), (trx) => loadWaiverSession(trx, A.id, secret))).toBeNull();
    expect((await sign(A.id, session, { signature: "Lee Leaving" })).kind).toBe("not_pending");
    const states = await admin<{ participant_id: string; state: string }[]>`
      select participant_id, state from public.waiver_requests where booking_id = ${booked.bookingId}`;
    expect(Object.fromEntries(states.map((s) => [s.participant_id, s.state]))).toEqual({
      [stay?.id ?? ""]: "pending",
      [leave?.id ?? ""]: "revoked",
    });
  });

  it("limits resends and replaces the earlier link", async () => {
    const booked = await book(A, 1);
    directory.set(booked.bookingId, [participant("Rex Resend")]);
    const assigned = await assign(A, booked.bookingId);
    const requestId = assigned.created[0]?.requestId ?? "";
    const firstToken = tokenOf(mailer.lastFor(requestId).link);
    const ctx = staffContext(A.id, "staff-resend");
    const tooSoon = await inTenant(ctx, (trx) =>
      sendWaiverRequest(trx, ctx, deps, { requestId, kind: "resend", reason: "Guest asked" }),
    );
    expect(tooSoon.kind).toBe("too_soon");
    // The database holds the same limit for any writer.
    expect(
      await pgError(
        admin.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${A.id}, true)`;
          const [t] = await tx<{ id: string }[]>`
          insert into public.waiver_access_tokens (tenant_id, request_id, purpose, token_hash, expires_at)
          values (${A.id}, ${requestId}, 'sign', ${"b".repeat(64)}, now() + interval '1 day') returning id`;
          await tx`insert into public.waiver_deliveries (tenant_id, request_id, generation, kind,
                   recipient_email, token_id, reason)
                 values (${A.id}, ${requestId}, 2, 'resend', 'rex.resend@example.test', ${t?.id ?? ""}, 'x')`;
        }),
      ),
    ).toBe("23514:waiver_deliveries_rate");
    // Ten minutes later (moved back by the owner, with the guard off for that one statement).
    await admin.begin(async (tx) => {
      await tx`alter table public.waiver_deliveries disable trigger waiver_deliveries_append_only`;
      await tx`update public.waiver_deliveries set created_at = created_at - interval '11 minutes'
                where request_id = ${requestId}`;
      await tx`alter table public.waiver_deliveries enable trigger waiver_deliveries_append_only`;
    });
    const resent = await inTenant(ctx, (trx) =>
      sendWaiverRequest(trx, ctx, deps, { requestId, kind: "resend", reason: "Guest asked" }),
    );
    expect(resent).toMatchObject({ kind: "sent", generation: 2 });
    expect((await redeem(A.id, firstToken)).kind).toBe("replaced");
    expect(mailer.lastFor(requestId).idempotencyKey).toBe(`waiver:${requestId}:2`);
  });

  it("moves unsigned requests to a new version on request and never touches signed evidence", async () => {
    const t = await createWaiverFixture(admin, runtime.db, "wv-ver");
    const tripId = t.trips.shared[0] ?? "";
    const booked = await bookParty(admin, runtime.db, t, tripId, 2);
    const [signer, waiter] = directory.set(booked.bookingId, [
      participant("Sid Signed"),
      participant("Wes Waiting"),
    ]);
    const assigned = await (async () => {
      const ctx = staffContext(t.id, "confirmation");
      return inTenant(ctx, (trx) =>
        assignBookingWaivers(trx, ctx, deps, { bookingId: booked.bookingId }),
      );
    })();
    const signerRequest =
      assigned.created.find((c) => c.participantId === signer?.id)?.requestId ?? "";
    const waiterRequest =
      assigned.created.find((c) => c.participantId === waiter?.id)?.requestId ?? "";
    const signedSession = await open(t.id, signerRequest);
    expect((await sign(t.id, signedSession.session)).kind).toBe("signed");
    const waiterSession = await open(t.id, waiterRequest);

    const ctx = staffContext(t.id, "owner");
    const published = await inTenant(ctx, (trx) =>
      publishWaiverTemplateVersion(trx, ctx, deps, {
        templateId: t.templateId,
        text: { ...FIXTURE_TEXT, body: `${FIXTURE_TEXT.body}\n\nA new paragraph.` },
        reason: "Counsel updated the text",
        reassignUnsigned: true,
      }),
    );
    expect(published).toMatchObject({ kind: "published", version: 2, reassigned: 1 });
    // The open session on the old version can no longer sign.
    const late = await sign(t.id, waiterSession.session);
    expect(late).toEqual({ kind: "not_pending", state: "superseded" });
    const rows = await admin<{ participant_id: string; template_version: number; state: string }[]>`
      select participant_id, template_version, state from public.waiver_requests
       where booking_id = ${booked.bookingId} order by created_at, template_version`;
    expect(rows.map((r) => [r.participant_id, r.template_version, r.state])).toEqual([
      [signer?.id, 1, "signed"],
      [waiter?.id, 1, "superseded"],
      [waiter?.id, 2, "pending"],
    ]);
    // The replacement went out, and its link opens version 2.
    const replacement = await admin<{ id: string }[]>`
      select id from public.waiver_requests where booking_id = ${booked.bookingId} and template_version = 2`;
    const v2 = await open(t.id, replacement[0]?.id ?? "");
    const view = await inTenant(guest(t.id), (trx) => getSigningView(trx, t.id, deps, v2.session));
    expect(view.waiver.version).toBe(2);
    // A participant added now gets version 2.
    const late2 = directory.add(booked.bookingId, participant("Lou Later"));
    const added = await (async () => {
      const c = staffContext(t.id, "participant-added");
      return inTenant(c, (trx) =>
        assignBookingWaivers(trx, c, deps, {
          bookingId: booked.bookingId,
          participantIds: [late2.id],
        }),
      );
    })();
    expect(added.version?.version).toBe(2);
  });
});
