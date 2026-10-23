/**
 * G2.15 core: templates, automatic assignment through the booking hooks,
 * delivery generations, link redemption, signing, evidence, participant
 * changes, revocation, and a version change, against PostgreSQL as
 * tidegrid_app. Bookings come from the real checkout, participants from the
 * booking module's own command, and links from the messaging module's real
 * delivery job and fake mailbox.
 */
import { createHash } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { hashLinkToken } from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  assignBookingWaivers,
  getSigningView,
  loadWaiverSession,
  publishWaiverTemplateVersion,
  reassignUnsignedRequests,
  redeemWaiverToken,
  revokeBookingWaivers,
  type SignInput,
  sendWaiverRequest,
  signWaiver,
  type WaiverDeps,
  type WaiverSession,
  waiverContentSha256,
} from "./index.ts";
import {
  adult,
  type Booked,
  bookParty,
  createWaiverFixture,
  deliverMail,
  FIXTURE_TEXT,
  fixtureDeps,
  fixtureHooks,
  linkFor,
  minor,
  nameParticipant,
  staffContext,
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
  let deps: WaiverDeps;
  let hooks: BookingHooks;
  let tripIndex = 0;

  const guest = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "guest",
    actorId: null,
    requestId: `guest-${Math.random()}`,
    sourceIp: "203.0.113.9",
  });

  async function book(t: WaiverFixture, party = 2): Promise<Booked> {
    const tripId = t.trips.shared[tripIndex++];
    if (!tripId) throw new Error("out of fixture trips");
    return bookParty(admin, runtime.db, t, tripId, party, hooks);
  }

  async function requestsOf(bookingId: string) {
    return admin<
      { id: string; participant_id: string; state: string; required_signer: string; v: number }[]
    >`select id, participant_id, state, required_signer, template_version as v
        from public.waiver_requests where booking_id = ${bookingId} order by created_at, id`;
  }

  async function messagesOf(requestId: string) {
    return admin<{ dedupe_key: string; to_email: string; state: string; to_name: string }[]>`
      select m.dedupe_key, m.to_email, m.state, m.to_name
        from public.email_messages m
       where m.subject_ref = ${`waiver_request:${requestId}`}
       order by m.created_at, m.dedupe_key`;
  }

  async function liveRequest(bookingId: string, participantId: string): Promise<string> {
    const [row] = await admin<{ id: string }[]>`
      select id from public.waiver_requests
       where booking_id = ${bookingId} and participant_id = ${participantId}
         and state in ('pending', 'signed')`;
    if (!row) throw new Error("no live request");
    return row.id;
  }

  async function redeem(tenantId: string, token: string) {
    const ctx = guest(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => redeemWaiverToken(trx, ctx, { token }));
  }

  async function open(
    tenantId: string,
    requestId: string,
  ): Promise<{ session: WaiverSession; secret: string }> {
    const { token } = await linkFor(admin, runtime.db, tenantId, requestId);
    const opened = await redeem(tenantId, token);
    if (opened.kind !== "opened") throw new Error(`redeem: ${JSON.stringify(opened)}`);
    return { session: opened.session, secret: opened.secret };
  }

  async function sign(tenantId: string, session: WaiverSession, input: Partial<SignInput> = {}) {
    const ctx = guest(tenantId);
    return inTenantTransaction(runtime.db, ctx, async (trx) => {
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
          signature: view.participant?.signerName ?? "",
          relationship: view.signerRole === "guardian" ? "parent" : null,
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
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(admin, runtime.db, "wv-a");
    B = await createWaiverFixture(admin, runtime.db, "wv-b");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("stores each version's hash from its canonical content, and never edits a version", async () => {
    const [version] = await admin<{ content_sha256: string }[]>`
      select content_sha256 from public.waiver_template_versions
       where tenant_id = ${A.id} and template_id = ${A.templateId} and version = 1`;
    expect(version?.content_sha256).toBe(await waiverContentSha256(FIXTURE_TEXT));
    expect(
      await pgError(
        admin`update public.waiver_template_versions set title = 'x' where tenant_id = ${A.id}`,
      ),
    ).toBe("55000");
    expect(
      await pgError(admin`delete from public.waiver_template_versions where tenant_id = ${A.id}`),
    ).toBe("55000");
  });

  it("assigns each participant as they are named, with the signer a minor needs, and emails once", async () => {
    const booked = await book(A, 3);
    // Confirmation found nobody named yet.
    expect(await requestsOf(booked.bookingId)).toEqual([]);
    const ada = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      adult("Ada Adult"),
      hooks,
    );
    const milo = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      2,
      minor("Milo Minor", { name: "Gail Guardian", email: "gail.guardian@example.test" }),
      hooks,
    );
    const nora = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      3,
      adult("Nora Noemail", null),
      hooks,
    );
    const rows = await requestsOf(booked.bookingId);
    expect(rows.map((r) => [r.participant_id, r.required_signer, r.state])).toEqual([
      [ada.participant.id, "participant", "pending"],
      [milo.participant.id, "guardian", "pending"],
      [nora.participant.id, "participant", "pending"],
    ]);
    const [adaRequest, miloRequest, noraRequest] = rows.map((r) => r.id);
    expect(await messagesOf(miloRequest ?? "")).toEqual([
      {
        dedupe_key: `waiver.request:${miloRequest}:1`,
        to_email: "gail.guardian@example.test",
        state: "queued",
        to_name: "Gail Guardian",
      },
    ]);
    // Nora has no address yet, so nothing went to her.
    expect(await messagesOf(noraRequest ?? "")).toEqual([]);

    // The same details again change nothing; a retried assignment creates nothing.
    await nameParticipant(runtime.db, A.id, booked.bookingId, 1, adult("Ada Adult"), hooks);
    const ctx = staffContext(A.id, "retry");
    const again = await inTenantTransaction(runtime.db, ctx, (trx) =>
      assignBookingWaivers(trx, ctx, deps, { bookingId: booked.bookingId }),
    );
    expect(again.created).toEqual([]);
    expect(again.alreadyAssigned).toBe(3);
    expect(await messagesOf(adaRequest ?? "")).toHaveLength(1);

    // Nora's address arrives: her request goes out now.
    await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      3,
      adult("Nora Noemail", "nora@example.test"),
      hooks,
    );
    expect((await messagesOf(noraRequest ?? "")).map((m) => [m.dedupe_key, m.to_email])).toEqual([
      [`waiver.request:${noraRequest}:1`, "nora@example.test"],
    ]);

    // The guardian's email, as sent: the link opens the guest site's /waiver
    // page with the token in its fragment, and only the token's hash is stored.
    const sent = await linkFor(admin, runtime.db, A.id, miloRequest ?? "");
    expect(sent.to).toBe("gail.guardian@example.test");
    expect(sent.subject).toContain("Milo Minor");
    expect(sent.link.startsWith(`https://${A.host}/waiver#t=`)).toBe(true);
    const stored = await admin<{ token_hash: string }[]>`
      select token_hash from public.guest_access_links
       where subject_ref = ${`waiver_request:${miloRequest}`}`;
    expect(stored.map((s) => s.token_hash)).toEqual([await hashLinkToken(sent.token)]);
  });

  it("never assigns twice when assignments for one booking race", async () => {
    const booked = await book(A, 2);
    const noHooks: BookingHooks = {};
    await nameParticipant(runtime.db, A.id, booked.bookingId, 1, adult("Rae One"), noHooks);
    await nameParticipant(runtime.db, A.id, booked.bookingId, 2, adult("Rae Two"), noHooks);
    const ctx = staffContext(A.id, "race");
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        inTenantTransaction(runtime.db, ctx, (trx) =>
          assignBookingWaivers(trx, ctx, deps, { bookingId: booked.bookingId }),
        ),
      ),
    );
    expect(results.reduce((n, r) => n + r.created.length, 0)).toBe(2);
    const [row] = await admin<{ requests: number; deliveries: number; messages: number }[]>`
      select (select count(*)::int from public.waiver_requests where booking_id = ${booked.bookingId}) as requests,
             (select count(*)::int from public.waiver_deliveries d
                join public.waiver_requests r on r.id = d.request_id
               where r.booking_id = ${booked.bookingId}) as deliveries,
             (select count(*)::int from public.email_messages
               where booking_id = ${booked.bookingId} and template = 'waiver_request') as messages`;
    expect(row).toEqual({ requests: 2, deliveries: 2, messages: 2 });
  });

  it("redeems a link once, into a session bound to its request, only at its own operator", async () => {
    const booked = await book(A, 1);
    const sol = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      adult("Sol Signer"),
      hooks,
    );
    const requestId = await liveRequest(booked.bookingId, sol.participant.id);
    const { token } = await linkFor(admin, runtime.db, A.id, requestId);

    expect((await redeem(B.id, token)).kind).toBe("invalid");
    const opened = await redeem(A.id, token);
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;
    expect(opened.session).toMatchObject({
      requestId,
      bookingId: booked.bookingId,
      participantId: sol.participant.id,
      signerRole: "participant",
    });
    expect((await redeem(A.id, token)).kind).toBe("used");
    const found = await inTenantTransaction(runtime.db, guest(A.id), (trx) =>
      loadWaiverSession(trx, A.id, opened.secret),
    );
    expect(found?.id).toBe(opened.session.id);
    expect(
      await inTenantTransaction(runtime.db, guest(B.id), (trx) =>
        loadWaiverSession(trx, B.id, opened.secret),
      ),
    ).toBeNull();
    // No second session for the link, and none without consuming a link now.
    expect(
      await pgError(admin`
        insert into public.waiver_signing_sessions (tenant_id, access_link_id, request_id,
          booking_id, participant_id, purpose, signer_role, secret_hash, expires_at)
        select tenant_id, access_link_id, request_id, booking_id, participant_id, purpose,
               signer_role, repeat('a', 64), now() + interval '5 minutes'
          from public.waiver_signing_sessions where id = ${opened.session.id}`),
    ).toMatch(/^23(505|514)/);
  });

  it("signs once with every acknowledgment and the booking's name, and keeps the PDF with its hash", async () => {
    const booked = await book(A, 1);
    const zoe = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      adult("Zoë Example"),
      hooks,
    );
    const requestId = await liveRequest(booked.bookingId, zoe.participant.id);
    const { session } = await open(A.id, requestId);

    const refused = await sign(A.id, session, { signature: "Someone Else" });
    expect(refused.kind === "invalid" && refused.problems.map((p) => p.code)).toEqual([
      "does_not_match",
    ]);
    expect((await sign(A.id, session, { acknowledgments: [true, false] })).kind).toBe("invalid");
    expect((await sign(A.id, session, { consent: false })).kind).toBe("invalid");
    expect((await sign(A.id, session, { contentSha256: "0".repeat(64) })).kind).toBe(
      "content_changed",
    );

    const signed = await sign(A.id, session, { signature: "  zoë   EXAMPLE " });
    expect(signed.kind).toBe("signed");
    if (signed.kind !== "signed") return;
    expect(signed.view.signed?.signerName).toBe("Zoë Example");

    const [evidence] = await admin<
      {
        document: Buffer;
        document_sha256: string;
        signature_text: string;
        content_sha256: string;
        recipient_email: string;
      }[]
    >`select document, document_sha256, signature_text, content_sha256, recipient_email
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

    const again = await sign(A.id, session);
    expect(again.kind === "already_signed" && again.view.signed?.evidenceId).toBe(
      signed.view.signed?.evidenceId,
    );

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

  it("lets the named parent or guardian sign for a minor, with the relationship declared", async () => {
    const booked = await book(A, 1);
    const kit = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      minor("Kit Minor", { name: "Pat Parent", email: "pat.parent@example.test" }),
      hooks,
    );
    const requestId = await liveRequest(booked.bookingId, kit.participant.id);
    const { session } = await open(A.id, requestId);
    expect(session.signerRole).toBe("guardian");
    // The minor's own name, or no relationship, is refused.
    expect((await sign(A.id, session, { signature: "Kit Minor" })).kind).toBe("invalid");
    expect((await sign(A.id, session, { relationship: null })).kind).toBe("invalid");
    const signed = await sign(A.id, session, {
      signature: "Pat Parent",
      relationship: "legal_guardian",
    });
    expect(signed.kind).toBe("signed");
    const [row] = await admin<
      {
        signer_role: string;
        signer_name: string;
        guardian_relationship: string;
        participant_minor: boolean;
        participant_name: string;
      }[]
    >`select signer_role, signer_name, guardian_relationship, participant_minor, participant_name
        from public.waiver_evidence where request_id = ${requestId}`;
    expect(row).toEqual({
      signer_role: "guardian",
      signer_name: "Pat Parent",
      guardian_relationship: "legal_guardian",
      participant_minor: true,
      participant_name: "Kit Minor",
    });
  });

  it("follows corrections: a new address at once, a new signer or a renamed signer anew", async () => {
    const booked = await book(A, 2);
    const max = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      adult("Max Moved", "max.old@example.test"),
      hooks,
    );
    const firstRequest = await liveRequest(booked.bookingId, max.participant.id);
    const old = await linkFor(admin, runtime.db, A.id, firstRequest);
    // A corrected address goes out at once, despite the resend interval, and
    // the old link stops working.
    await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      adult("Max Moved", "max.new@example.test"),
      hooks,
    );
    expect((await messagesOf(firstRequest)).map((m) => [m.dedupe_key, m.to_email])).toEqual([
      [`waiver.request:${firstRequest}:1`, "max.old@example.test"],
      [`waiver.request:${firstRequest}:2`, "max.new@example.test"],
    ]);
    expect((await redeem(A.id, old.token)).kind).toBe("replaced");

    // Marked a minor after all: the request ends and a guardian's begins.
    await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      minor("Max Moved", { name: "Mo Guardian", email: "mo@example.test" }),
      hooks,
    );
    const afterFlip = await requestsOf(booked.bookingId);
    expect(afterFlip.map((r) => [r.required_signer, r.state])).toEqual([
      ["participant", "revoked"],
      ["guardian", "pending"],
    ]);
    // The ended request's queued email never goes out.
    expect((await messagesOf(firstRequest)).map((m) => m.state)).toEqual(["sent", "canceled"]);

    // Signed, then renamed: a different person must sign again.
    const lin = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      2,
      adult("Lin One"),
      hooks,
    );
    const linRequest = await liveRequest(booked.bookingId, lin.participant.id);
    const { session } = await open(A.id, linRequest);
    expect((await sign(A.id, session)).kind).toBe("signed");
    await nameParticipant(runtime.db, A.id, booked.bookingId, 2, adult("Lou Two"), hooks);
    const states = await admin<{ state: string; revoked_reason: string | null }[]>`
      select state, revoked_reason from public.waiver_requests
       where participant_id = ${lin.participant.id} order by created_at`;
    expect(states).toEqual([
      { state: "revoked", revoked_reason: "participant_changed" },
      { state: "pending", revoked_reason: null },
    ]);
    // The evidence of the first signature is untouched.
    const [kept] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.waiver_evidence where request_id = ${linRequest}`;
    expect(kept?.n).toBe(1);
  });

  it("limits resends to one mailbox and replaces the earlier link", async () => {
    const booked = await book(A, 1);
    const rex = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      adult("Rex Resend"),
      hooks,
    );
    const requestId = await liveRequest(booked.bookingId, rex.participant.id);
    const first = await linkFor(admin, runtime.db, A.id, requestId);
    const ctx = staffContext(A.id, "staff-resend");
    const resend = () =>
      inTenantTransaction(runtime.db, ctx, (trx) =>
        sendWaiverRequest(trx, ctx, deps, { requestId, kind: "resend", reason: "Guest asked" }),
      );
    expect((await resend()).kind).toBe("too_soon");
    // The database holds the same limit for any writer.
    const [message] = await admin<{ id: string }[]>`
      select message_id as id from public.waiver_deliveries where request_id = ${requestId}`;
    expect(
      await pgError(
        admin`insert into public.waiver_deliveries (tenant_id, request_id, generation, kind,
                recipient_email, message_id, reason)
              values (${A.id}, ${requestId}, 2, 'resend', 'rex.resend@example.test',
                      ${message?.id ?? ""}, 'x')`,
      ),
    ).toBe("23514:waiver_deliveries_rate");
    // Ten minutes later (moved back by the owner, with the guard off for that statement only).
    await admin.begin(async (tx) => {
      await tx`alter table public.waiver_deliveries disable trigger waiver_deliveries_append_only`;
      await tx`update public.waiver_deliveries set created_at = created_at - interval '11 minutes',
                      send_after = send_after - interval '11 minutes'
                where request_id = ${requestId}`;
      await tx`alter table public.waiver_deliveries enable trigger waiver_deliveries_append_only`;
    });
    expect(await resend()).toMatchObject({ kind: "sent", generation: 2 });
    const second = await linkFor(admin, runtime.db, A.id, requestId);
    expect(second.token).not.toBe(first.token);
    expect((await redeem(A.id, first.token)).kind).toBe("replaced");
    expect((await redeem(A.id, second.token)).kind).toBe("opened");
  });

  it("ends every request when the booking is canceled, links, sessions, and queued email with them", async () => {
    const booked = await book(A, 2);
    const cy = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      1,
      adult("Cy Cancel"),
      hooks,
    );
    const requestId = await liveRequest(booked.bookingId, cy.participant.id);
    const { session, secret } = await open(A.id, requestId);
    const dee = await nameParticipant(
      runtime.db,
      A.id,
      booked.bookingId,
      2,
      adult("Dee Queued"),
      hooks,
    );
    const queuedRequest = await liveRequest(booked.bookingId, dee.participant.id);
    const ctx = staffContext(A.id, "cancellation");
    const revoked = await inTenantTransaction(runtime.db, ctx, (trx) =>
      revokeBookingWaivers(trx, ctx, { bookingId: booked.bookingId }),
    );
    expect(revoked.revoked).toBe(2);
    expect(
      await inTenantTransaction(runtime.db, guest(A.id), (trx) =>
        loadWaiverSession(trx, A.id, secret),
      ),
    ).toBeNull();
    expect((await sign(A.id, session)).kind).toBe("not_pending");
    expect((await messagesOf(queuedRequest)).map((m) => m.state)).toEqual(["canceled"]);
    await deliverMail(runtime.db, A.id);
    expect((await messagesOf(queuedRequest)).map((m) => m.state)).toEqual(["canceled"]);
  });

  it("moves unsigned requests to a new version on request and never touches signed evidence", async () => {
    const t = await createWaiverFixture(admin, runtime.db, "wv-ver");
    const booked = await bookParty(admin, runtime.db, t, t.trips.shared[0] ?? "", 3, hooks);
    const sid = await nameParticipant(
      runtime.db,
      t.id,
      booked.bookingId,
      1,
      adult("Sid Signed"),
      hooks,
    );
    const wes = await nameParticipant(
      runtime.db,
      t.id,
      booked.bookingId,
      2,
      adult("Wes Waiting"),
      hooks,
    );
    const sidRequest = await liveRequest(booked.bookingId, sid.participant.id);
    const wesRequest = await liveRequest(booked.bookingId, wes.participant.id);
    expect((await sign(t.id, (await open(t.id, sidRequest)).session)).kind).toBe("signed");
    const wesSession = await open(t.id, wesRequest);

    const ctx = staffContext(t.id, "owner");
    const published = await inTenantTransaction(runtime.db, ctx, (trx) =>
      publishWaiverTemplateVersion(trx, ctx, {
        templateId: t.templateId,
        text: { ...FIXTURE_TEXT, body: `${FIXTURE_TEXT.body}\n\nA new paragraph.` },
        reason: "Counsel updated the text",
      }),
    );
    expect(published).toMatchObject({ kind: "published", version: 2 });
    expect(
      await reassignUnsignedRequests(runtime.db, ctx, deps, {
        templateId: t.templateId,
        version: 2,
      }),
    ).toEqual({ kind: "reassigned", moved: 1 });
    expect(await sign(t.id, wesSession.session)).toEqual({
      kind: "not_pending",
      state: "superseded",
    });
    const rows = await requestsOf(booked.bookingId);
    expect(rows.map((r) => [r.participant_id, r.v, r.state])).toEqual([
      [sid.participant.id, 1, "signed"],
      [wes.participant.id, 1, "superseded"],
      [wes.participant.id, 2, "pending"],
    ]);
    const replacement = await liveRequest(booked.bookingId, wes.participant.id);
    const v2 = await open(t.id, replacement);
    const view = await inTenantTransaction(runtime.db, guest(t.id), (trx) =>
      getSigningView(trx, t.id, deps, v2.session),
    );
    expect(view.waiver.version).toBe(2);
    // A participant named now gets version 2.
    const lou = await nameParticipant(
      runtime.db,
      t.id,
      booked.bookingId,
      3,
      adult("Lou Later"),
      hooks,
    );
    const [late] = await admin<{ v: number }[]>`
      select template_version as v from public.waiver_requests where participant_id = ${lou.participant.id}`;
    expect(late?.v).toBe(2);
  });
});
