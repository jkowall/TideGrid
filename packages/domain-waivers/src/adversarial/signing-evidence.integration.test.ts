/**
 * G2.15 adversarial: signing and evidence, against the waiver contract ("The
 * rule", "Signing", "Which version applies") and the waiver migration's
 * triggers, for the owner and for tidegrid_app.
 *
 * - Guardian flows: a minor's request needs the guardian, the guardian's name
 *   as the booking gives it, and a relationship; one guardian signs for two
 *   minors as two requests, two links, and two evidence rows; a change of who
 *   must sign, before or after signing, starts a new request.
 * - A version change mid-flight, with and without moving unsigned work; signed
 *   evidence untouched; a stale content hash refused; supersede racing signing.
 * - Two sessions of one request racing to sign: one evidence row.
 * - Evidence, versions, templates, and deliveries never change for any role; a
 *   request never moves back; evidence cannot be forged around the chain.
 */
import { createHash, randomUUID } from "node:crypto";
import { inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { hashLinkToken } from "@tidegrid/domain-messaging";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  getSigningView,
  loadWaiverSession,
  publishWaiverTemplateVersion,
  revokeParticipantWaivers,
  sendWaiverRequest,
  type SignInput,
  signWaiver,
  type WaiverDeps,
  type WaiverSession,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  FIXTURE_TEXT,
  fixtureDeps,
  fixtureHooks,
  linkFor,
  minor,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  ageDeliveries,
  asApp,
  barrier,
  book,
  closeWorld,
  guestCtx,
  liveRequest,
  name,
  openFor,
  openWorld,
  Rollback,
  redeem,
  type Sql,
  settle,
  sign,
  signingInput,
  systemCtx,
  trips,
  uniqueEmail,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");
const ROUNDS = 3;
const META = { sourceIp: "198.51.100.7", userAgent: "waiver-adversary" };

describe.skipIf(!env)("G2.15 adversarial: signing and evidence", () => {
  let world: World;
  let A: WaiverFixture;
  let nextTrip: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 12);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvs", { days: 8 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  const loads = async (tenantId: string, secret: string) =>
    (await inTenantTransaction(world.db, guestCtx(tenantId), (trx) =>
      loadWaiverSession(trx, tenantId, secret),
    )) !== null;

  /** A request's evidence row as stored, every column, as text. */
  async function evidenceOf(requestId: string): Promise<string | null> {
    const [row] = await world.admin<{ row: string }[]>`
      select row_to_json(e)::text as row from public.waiver_evidence e
       where e.request_id = ${requestId}`;
    return row?.row ?? null;
  }

  function racingSign(
    tenantId: string,
    session: WaiverSession,
    input: SignInput,
    start: ReturnType<typeof barrier>,
  ) {
    const ctx = guestCtx(tenantId);
    return settle(
      inTenantTransaction(world.db, ctx, async (trx) => {
        await start.arrive();
        return signWaiver(trx, ctx, deps, session, input, META);
      }),
    );
  }

  it(
    "lets only the named guardian sign for each minor, with a relationship, and starts over when who signs changes",
    async () => {
      const booked = await book(world, A, nextTrip(), 3, hooks);
      const gwen = { name: "Gwen Guardian", email: uniqueEmail("gwen") };
      const mia = await name(world, A.id, booked.bookingId, 1, minor("Mia Minor", gwen), hooks);
      const max = await name(world, A.id, booked.bookingId, 2, minor("Max Minor", gwen), hooks);
      const abe = await name(world, A.id, booked.bookingId, 3, adult("Abe Adult"), hooks);
      const rMia = await liveRequest(world.admin, booked.bookingId, mia);
      const rMax = await liveRequest(world.admin, booked.bookingId, max);
      expect([rMia.required_signer, rMax.required_signer]).toEqual(["guardian", "guardian"]);

      // One guardian, two minors: two emails, two links, each naming its own request.
      const miaMail = await linkFor(world.admin, world.db, A.id, rMia.id);
      const maxMail = await linkFor(world.admin, world.db, A.id, rMax.id);
      expect([miaMail.to, maxMail.to]).toEqual([gwen.email, gwen.email]);
      expect(miaMail.token).not.toBe(maxMail.token);
      const subjects = await world.admin<{ subject_ref: string }[]>`
        select subject_ref from public.guest_access_links
         where token_hash in (${await hashLinkToken(miaMail.token)}, ${await hashLinkToken(maxMail.token)})
         order by subject_ref`;
      expect(subjects.map((s) => s.subject_ref).sort()).toEqual(
        [`waiver_request:${rMia.id}`, `waiver_request:${rMax.id}`].sort(),
      );

      const miaOpen = await redeem(world, A.id, miaMail.token);
      if (miaOpen.kind !== "opened") throw new Error("mia did not open");
      expect(miaOpen.session).toMatchObject({ requestId: rMia.id, signerRole: "guardian" });
      // The minor's own name, a stranger's, or no relationship: refused, field by field.
      for (const [overrides, field, code] of [
        [{ signature: "Mia Minor" }, "signature", "does_not_match"],
        [{ signature: "Some Stranger" }, "signature", "does_not_match"],
        [{ relationship: null }, "relationship", "required"],
        [{ confirmIdentity: false }, "confirmIdentity", "required"],
      ] as const) {
        const refused = await sign(world, A.id, deps, miaOpen.session, overrides);
        expect(refused.kind === "invalid" && refused.problems.map((p) => [p.field, p.code])).toEqual(
          [[field, code]],
        );
      }
      expect(
        (await sign(world, A.id, deps, miaOpen.session, { signature: " gwen  GUARDIAN " })).kind,
      ).toBe("signed");
      const maxOpen = await redeem(world, A.id, maxMail.token);
      if (maxOpen.kind !== "opened") throw new Error("max did not open");
      expect(
        (await sign(world, A.id, deps, maxOpen.session, { relationship: "legal_guardian" })).kind,
      ).toBe("signed");
      const evidence = await world.admin<
        {
          participant_name: string;
          participant_minor: boolean;
          signer_role: string;
          signer_name: string;
          guardian_relationship: string | null;
        }[]
      >`select participant_name, participant_minor, signer_role, signer_name, guardian_relationship
          from public.waiver_evidence where booking_id = ${booked.bookingId}
         order by participant_name`;
      expect(evidence).toEqual([
        {
          participant_name: "Max Minor",
          participant_minor: true,
          signer_role: "guardian",
          signer_name: "Gwen Guardian",
          guardian_relationship: "legal_guardian",
        },
        {
          participant_name: "Mia Minor",
          participant_minor: true,
          signer_role: "guardian",
          signer_name: "Gwen Guardian",
          guardian_relationship: "parent",
        },
      ]);

      // An adult gives no relationship.
      const rAbe = await liveRequest(world.admin, booked.bookingId, abe);
      const abeOpen = await openFor(world, A.id, rAbe.id);
      const abeRefused = await sign(world, A.id, deps, abeOpen.session, { relationship: "parent" });
      expect(
        abeRefused.kind === "invalid" && abeRefused.problems.map((p) => [p.field, p.code]),
      ).toEqual([["relationship", "not_applicable"]]);

      // Before signing, the adult turns out to be a minor: the session ends, a guardian's request begins.
      const gus = { name: "Gus Guard", email: uniqueEmail("gus") };
      await name(world, A.id, booked.bookingId, 3, minor("Abe Adult", gus), hooks);
      expect(await loads(A.id, abeOpen.secret)).toBe(false);
      expect(await sign(world, A.id, deps, abeOpen.session)).toEqual({
        kind: "not_pending",
        state: "revoked",
      });
      const abeNow = await liveRequest(world.admin, booked.bookingId, abe);
      expect([abeNow.required_signer, abeNow.state]).toEqual(["guardian", "pending"]);
      expect((await linkFor(world.admin, world.db, A.id, abeNow.id)).to).toBe(gus.email);

      // After signing, a minor turns out to be an adult: the signature is revoked, its evidence kept.
      const miaEvidence = await evidenceOf(rMia.id);
      await name(world, A.id, booked.bookingId, 1, adult("Mia Minor", uniqueEmail("mia")), hooks);
      const [miaOld] = await world.admin<{ state: string; revoked_reason: string }[]>`
        select state, revoked_reason from public.waiver_requests where id = ${rMia.id}`;
      expect(miaOld).toEqual({ state: "revoked", revoked_reason: "participant_changed" });
      expect(await evidenceOf(rMia.id)).toBe(miaEvidence);
      const miaNow = await liveRequest(world.admin, booked.bookingId, mia);
      expect([miaNow.required_signer, miaNow.state]).toEqual(["participant", "pending"]);
      // A minor never signs as a participant: no session or evidence can say so (see the forgery test).
    },
    240_000,
  );

  it(
    "asks a minor's guardian to sign again when the booking renames the guardian after they signed",
    async () => {
      const booked = await book(world, A, nextTrip(), 1, hooks);
      const email = uniqueEmail("gil");
      const kid = await name(
        world,
        A.id,
        booked.bookingId,
        1,
        minor("Kit Kid", { name: "Gil Guardian", email }),
        hooks,
      );
      const request = await liveRequest(world.admin, booked.bookingId, kid);
      const { session } = await openFor(world, A.id, request.id);
      expect((await sign(world, A.id, deps, session)).kind).toBe("signed");
      // The booking now names someone else as the guardian who signs for Kit.
      await name(
        world,
        A.id,
        booked.bookingId,
        1,
        minor("Kit Kid", { name: "Hana Otherguardian", email }),
        hooks,
      );
      const requests = await world.admin<{ state: string; revoked_reason: string | null }[]>`
        select state, revoked_reason from public.waiver_requests
         where participant_id = ${kid} order by created_at, id`;
      // As for an adult renamed after signing: the old signature no longer names who signs.
      expect(requests).toEqual([
        { state: "revoked", revoked_reason: "participant_changed" },
        { state: "pending", revoked_reason: null },
      ]);
    },
    180_000,
  );

  it(
    "keeps signed versions, refuses a stale hash, and moves only unsigned work when asked",
    async () => {
      const t = await createWaiverFixture(world.admin, world.db, "wvs-ver", { days: 1 + ROUNDS });
      const booked = await book(world, t, t.trips.shared[0] ?? "", 4, hooks);
      const named = async (position: number, who: string) => {
        const pid = await name(world, t.id, booked.bookingId, position, adult(who), hooks);
        return { pid, request: (await liveRequest(world.admin, booked.bookingId, pid)).id };
      };
      const p1 = await named(1, "Vic One");
      expect((await sign(world, t.id, deps, (await openFor(world, t.id, p1.request)).session)).kind)
        .toBe("signed");
      const p2 = await named(2, "Vic Two");
      const o2 = await openFor(world, t.id, p2.request);
      const p3 = await named(3, "Vic Three");
      const o3 = await openFor(world, t.id, p3.request);
      const owner = systemCtx(t.id, "owner");
      const publish = (body: string, reassignUnsigned: boolean) =>
        inTenantTransaction(world.db, owner, (trx) =>
          publishWaiverTemplateVersion(trx, owner, deps, {
            templateId: t.templateId,
            text: { ...FIXTURE_TEXT, body: `${FIXTURE_TEXT.body}\n\n${body}` },
            reason: "Synthetic revision",
            reassignUnsigned,
          }),
        );

      // Version 2, unsigned work left where it is.
      const v2 = await publish("Second synthetic paragraph.", false);
      if (v2.kind !== "published") throw new Error(JSON.stringify(v2));
      expect(v2).toMatchObject({ version: 2, reassigned: 0 });
      expect((await liveRequest(world.admin, booked.bookingId, p2.pid)).v).toBe(1);
      const v1Hash = (
        await inTenantTransaction(world.db, guestCtx(t.id), (trx) =>
          getSigningView(trx, t.id, deps, o2.session),
        )
      ).waiver.contentSha256;
      // The open version 1 session signs version 1, and nothing else.
      expect((await sign(world, t.id, deps, o3.session, { contentSha256: v2.contentSha256 })).kind)
        .toBe("content_changed");
      expect((await sign(world, t.id, deps, o2.session)).kind).toBe("signed");
      const [v1Signed] = await world.admin<{ content_sha256: string; template_version: number }[]>`
        select content_sha256, template_version from public.waiver_evidence
         where request_id = ${p2.request}`;
      expect(v1Signed).toEqual({ content_sha256: v1Hash, template_version: 1 });
      // Someone named now gets version 2.
      const p4 = await named(4, "Vic Four");
      expect((await liveRequest(world.admin, booked.bookingId, p4.pid)).v).toBe(2);
      const o4 = await openFor(world, t.id, p4.request);

      // Version 3, unsigned work moved: both unsigned requests, and nothing signed.
      const signedBefore = [await evidenceOf(p1.request), await evidenceOf(p2.request)];
      const v3 = await publish("Third synthetic paragraph.", true);
      expect(v3).toMatchObject({ kind: "published", version: 3, reassigned: 2 });
      for (const [p, o] of [
        [p3, o3],
        [p4, o4],
      ] as const) {
        expect(await loads(t.id, o.secret)).toBe(false);
        expect(await sign(world, t.id, deps, o.session)).toEqual({
          kind: "not_pending",
          state: "superseded",
        });
        const now = await liveRequest(world.admin, booked.bookingId, p.pid);
        expect([now.v, now.state]).toEqual([3, "pending"]);
        const [old] = await world.admin<{ superseded_by: string }[]>`
          select superseded_by from public.waiver_requests where id = ${p.request}`;
        expect(old?.superseded_by).toBe(now.id);
      }
      expect([await evidenceOf(p1.request), await evidenceOf(p2.request)]).toEqual(signedBefore);
      const states = await world.admin<{ state: string; v: number }[]>`
        select state, template_version as v from public.waiver_requests
         where id in (${p1.request}, ${p2.request}) order by id`;
      expect(states.map((s) => [s.state, s.v])).toEqual([
        ["signed", 1],
        ["signed", 1],
      ]);
      // The replacement shows version 3, and an earlier version's hash is stale for it.
      const p3Now = await liveRequest(world.admin, booked.bookingId, p3.pid);
      const o3b = await openFor(world, t.id, p3Now.id);
      for (const stale of [v1Hash, v2.contentSha256]) {
        expect((await sign(world, t.id, deps, o3b.session, { contentSha256: stale })).kind).toBe(
          "content_changed",
        );
      }
      expect((await sign(world, t.id, deps, o3b.session)).kind).toBe("signed");

      // Supersede racing a signature on one request: exactly one wins.
      const winners: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const raced = await book(world, t, t.trips.shared[1 + round] ?? "", 1, hooks);
        const pid = await name(world, t.id, raced.bookingId, 1, adult(`Rex Race ${round}`), hooks);
        const request = (await liveRequest(world.admin, raced.bookingId, pid)).id;
        const { session } = await openFor(world, t.id, request);
        const input = await signingInput(world, t.id, deps, session);
        const start = barrier(2);
        const [signed, published] = await Promise.all([
          racingSign(t.id, session, input, start),
          settle(
            inTenantTransaction(world.db, owner, async (trx) => {
              await start.arrive();
              return publishWaiverTemplateVersion(trx, owner, deps, {
                templateId: t.templateId,
                text: { ...FIXTURE_TEXT, body: `${FIXTURE_TEXT.body}\n\nRace ${round}.` },
                reason: "Synthetic revision",
                reassignUnsigned: true,
              });
            }),
          ),
        ]);
        expect([signed.ok, published.ok]).toEqual([true, true]);
        if (!signed.ok) continue;
        const [row] = await world.admin<{ state: string; evidence: number }[]>`
          select r.state, (select count(*)::int from public.waiver_evidence e
                            where e.request_id = r.id) as evidence
            from public.waiver_requests r where r.id = ${request}`;
        if (signed.value.kind === "signed") {
          expect(row).toEqual({ state: "signed", evidence: 1 });
        } else {
          expect(signed.value).toEqual({ kind: "not_pending", state: "superseded" });
          expect(row).toEqual({ state: "superseded", evidence: 0 });
        }
        winners.push(signed.value.kind);
        expect((await liveRequest(world.admin, raced.bookingId, pid)).state).toMatch(
          /^(signed|pending)$/,
        );
      }
      const [orphans] = await world.admin<{ n: number }[]>`
        select count(*)::int as n from public.waiver_evidence e
          join public.waiver_requests r on r.tenant_id = e.tenant_id and r.id = e.request_id
         where r.tenant_id = ${t.id} and r.state = 'superseded'`;
      expect(orphans?.n).toBe(0);
      expect(winners).toHaveLength(ROUNDS);
    },
    300_000,
  );

  it(
    "records one signature when two open sessions of one request sign at once",
    async () => {
      const booked = await book(world, A, nextTrip(), 2, hooks);
      for (let round = 0; round < 2; round++) {
        const pid = await name(
          world,
          A.id,
          booked.bookingId,
          round + 1,
          adult(`Dot Double ${round}`),
          hooks,
        );
        const request = (await liveRequest(world.admin, booked.bookingId, pid)).id;
        const first = await openFor(world, A.id, request);
        await ageDeliveries(world.admin, request);
        const ctx = systemCtx(A.id, "staff-resend");
        await inTenantTransaction(world.db, ctx, (trx) =>
          sendWaiverRequest(trx, ctx, deps, { requestId: request, kind: "resend", reason: "Again" }),
        );
        const second = await openFor(world, A.id, request);
        const inputs = [
          await signingInput(world, A.id, deps, first.session),
          await signingInput(world, A.id, deps, second.session),
        ] as const;
        const start = barrier(2);
        const results = await Promise.all([
          racingSign(A.id, first.session, inputs[0], start),
          racingSign(A.id, second.session, inputs[1], start),
        ]);
        expect(results.every((r) => r.ok)).toBe(true);
        const kinds = results.map((r) => (r.ok ? r.value.kind : "error"));
        expect([...kinds].sort()).toEqual(["not_pending", "signed"]);
        const winner = kinds[0] === "signed" ? first.session : second.session;
        const loser = results[kinds[0] === "signed" ? 1 : 0];
        expect(loser?.ok && loser.value).toEqual({ kind: "not_pending", state: "signed" });
        const evidence = await world.admin<{ session_id: string }[]>`
          select session_id from public.waiver_evidence where request_id = ${request}`;
        expect(evidence).toEqual([{ session_id: winner.id }]);
      }
    },
    180_000,
  );

  it(
    "never changes evidence, versions, templates, or deliveries, never moves a request back, and refuses forged evidence, for the owner and for tidegrid_app",
    async () => {
      const booked = await book(world, A, nextTrip(), 4, hooks);
      const p1 = await name(world, A.id, booked.bookingId, 1, adult("Ann Signed"), hooks);
      const p2 = await name(world, A.id, booked.bookingId, 2, adult("Ben Pending"), hooks);
      const p3 = await name(
        world,
        A.id,
        booked.bookingId,
        3,
        minor("Cal Minor", { name: "Dina Guardian", email: uniqueEmail("dina") }),
        hooks,
      );
      const p4 = await name(world, A.id, booked.bookingId, 4, adult("Dan Revoked"), hooks);
      const r1 = (await liveRequest(world.admin, booked.bookingId, p1)).id;
      const r2 = (await liveRequest(world.admin, booked.bookingId, p2)).id;
      const r3 = (await liveRequest(world.admin, booked.bookingId, p3)).id;
      const r4 = (await liveRequest(world.admin, booked.bookingId, p4)).id;
      const s1 = await openFor(world, A.id, r1);
      expect((await sign(world, A.id, deps, s1.session)).kind).toBe("signed");
      const s2 = await openFor(world, A.id, r2);
      const s3 = await openFor(world, A.id, r3);
      const sys = systemCtx(A.id, "revoker");
      await inTenantTransaction(world.db, sys, (trx) =>
        revokeParticipantWaivers(trx, sys, {
          bookingId: booked.bookingId,
          participantId: p4,
          reason: "participant_changed",
        }),
      );

      const appendOnly = [
        ["waiver_evidence", "signer_name = 'Changed Name'"],
        ["waiver_template_versions", "title = 'Changed title'"],
        ["waiver_templates", "name = 'Changed name'"],
        ["waiver_deliveries", "recipient_email = 'changed@example.test'"],
      ] as const;
      const fingerprint = async () =>
        Promise.all(
          [...appendOnly.map(([table]) => table), "waiver_requests", "waiver_signing_sessions"].map(
            async (table) => {
              const [row] = await world.admin.unsafe<{ fp: string }[]>(
                `select md5(coalesce(string_agg(row_to_json(x)::text, ',' order by row_to_json(x)::text), '')) as fp
                   from public.${table} x where x.tenant_id = $1`,
                [A.id],
              );
              return row?.fp;
            },
          ),
        );
      const before = await fingerprint();
      type Run = (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
      const roles: { role: string; run: Run; denied: string }[] = [
        {
          role: "owner",
          run: (fn) => world.admin.begin((tx) => fn(tx as unknown as Sql)),
          denied: "55000",
        },
        { role: "tidegrid_app", run: (fn) => asApp(world, A.id, fn), denied: "42501" },
      ];
      const outcome = async (p: Promise<unknown>) => {
        const settled = await settle(p);
        if (settled.ok) return "committed";
        if (settled.message === "rolled back on purpose") return "accepted";
        return settled.constraint ? `${settled.code}:${settled.constraint}` : settled.code;
      };
      /** One statement in its own transaction, always rolled back if it ran. */
      const attempt = (run: Run, sql: string, params: unknown[] = []) =>
        outcome(
          run(async (tx) => {
            await tx.unsafe(sql, params as never[]);
            throw new Rollback();
          }),
        );

      const tried: Record<string, string> = {};
      for (const { role, run } of roles) {
        for (const [table, set] of appendOnly) {
          tried[`${role} update ${table}`] = await attempt(
            run,
            `update public.${table} set ${set} where tenant_id = $1`,
            [A.id],
          );
        }
        for (const table of [...appendOnly.map(([t]) => t), "waiver_requests", "waiver_signing_sessions"]) {
          tried[`${role} delete ${table}`] = await attempt(
            run,
            `delete from public.${table} where tenant_id = $1`,
            [A.id],
          );
          tried[`${role} truncate ${table}`] = await attempt(
            run,
            `truncate public.${table} cascade`,
          );
        }
      }
      for (const [what, got] of Object.entries(tried)) {
        expect(got, what).toBe(what.startsWith("owner") ? "55000" : "42501");
      }

      // A request moves one way, for both roles; it is signed only with its evidence.
      for (const { role, run } of roles) {
        const transitions: Record<string, string> = {
          "signed to pending": await attempt(
            run,
            "update public.waiver_requests set state = 'pending' where id = $1",
            [r1],
          ),
          "signed to superseded": await attempt(
            run,
            "update public.waiver_requests set state = 'superseded', superseded_by = $2 where id = $1",
            [r1, r2],
          ),
          "revoked to pending": await attempt(
            run,
            "update public.waiver_requests set state = 'pending', revoked_reason = null where id = $1",
            [r4],
          ),
          "revoked to signed": await attempt(
            run,
            "update public.waiver_requests set state = 'signed', revoked_reason = null where id = $1",
            [r4],
          ),
          "pending to signed without evidence": await attempt(
            run,
            "update public.waiver_requests set state = 'signed' where id = $1",
            [r2],
          ),
        };
        expect(transitions, role).toEqual({
          "signed to pending": "23514:waiver_requests_transition",
          "signed to superseded": "23514:waiver_requests_transition",
          "revoked to pending": "23514:waiver_requests_transition",
          "revoked to signed": "23514:waiver_requests_transition",
          "pending to signed without evidence": "23514:waiver_requests_signed_evidence",
        });
      }

      // Forged evidence: everything right but one thing, for each role.
      const [facts] = await world.admin<
        {
          template_id: string;
          template_version: number;
          content_sha256: string;
          acknowledgments: string[];
        }[]
      >`select r.template_id, r.template_version, r.content_sha256, v.acknowledgments
          from public.waiver_requests r
          join public.waiver_template_versions v
            on v.tenant_id = r.tenant_id and v.template_id = r.template_id
           and v.version = r.template_version
         where r.id = ${r2}`;
      if (!facts) throw new Error("no request facts");
      const document = Buffer.from(
        `%PDF-1.4\n${"Synthetic forged document, not a signature. ".repeat(3)}\n%%EOF\n`,
        "latin1",
      );
      const sha = createHash("sha256").update(document).digest("hex");
      const evidence = {
        request: r2,
        participant: p2,
        session: s2.session.id,
        minor: false,
        role: "participant",
        relationship: null as string | null,
        hash: facts.content_sha256,
        acknowledgments: facts.acknowledgments,
        document,
        documentSha: sha,
      };
      type Forged = typeof evidence;
      const forge = (tx: Sql, v: Forged) => tx`
        insert into public.waiver_evidence (tenant_id, request_id, booking_id, participant_id,
          session_id, template_id, template_version, content_sha256, rendering_version,
          participant_name, participant_minor, signer_role, signer_name, guardian_relationship,
          signature_method, signature_text, acknowledgments, consent_version, consent_text,
          access_method, recipient_email, match_method, document, document_sha256)
        values (${A.id}, ${v.request}, ${booked.bookingId}, ${v.participant}, ${v.session},
                ${facts.template_id}, ${facts.template_version}, ${v.hash}, 1, 'Forged Name',
                ${v.minor}, ${v.role}, 'Forged Signer', ${v.relationship}, 'typed_name',
                'Forged Signer', ${tx.array(v.acknowledgments)}, 'esign-v1', 'Synthetic consent',
                'email_link', 'forged@example.test', 'signer_confirmed', ${v.document},
                ${v.documentSha})`;
      for (const { role, run } of roles) {
        const once = (v: Forged, then?: (tx: Sql) => Promise<unknown>) =>
          outcome(
            run(async (tx) => {
              await forge(tx, v);
              if (then) await then(tx);
              throw new Rollback();
            }),
          );
        const forged: Record<string, string> = {
          "another request's session": await once({ ...evidence, session: s3.session.id }),
          "no session": await once({ ...evidence, session: randomUUID() }),
          "another hash": await once({ ...evidence, hash: "0".repeat(64) }),
          "an acknowledgment missing": await once({
            ...evidence,
            acknowledgments: facts.acknowledgments.slice(1),
          }),
          "a PDF that is not its hash": await once({ ...evidence, documentSha: "0".repeat(64) }),
          "a minor signed as a participant": await once({
            ...evidence,
            request: r3,
            participant: p3,
            session: s3.session.id,
          }),
          "a request already signed": await once({
            ...evidence,
            request: r1,
            participant: p1,
            session: s1.session.id,
          }),
          // Everything right, and the request signed beside it: the database accepts this,
          // which shows each refusal above is the rule it names.
          control: await once(evidence, async (tx) => {
            await tx`update public.waiver_requests set state = 'signed' where id = ${r2}`;
            await tx`set constraints all immediate`;
          }),
        };
        expect(forged, role).toMatchObject({
          "another request's session": "23514:waiver_evidence_session",
          "no session": "23514:waiver_evidence_session",
          "another hash": "23514:waiver_evidence_request",
          "an acknowledgment missing": "23514:waiver_evidence_version",
          "a minor signed as a participant": "23514:waiver_evidence_request",
          "a request already signed": "23514:waiver_evidence_request",
          control: "accepted",
        });
        expect(forged["a PDF that is not its hash"], role).toMatch(/^23514/);
        // Evidence that would commit beside a request still pending is refused at commit.
        expect(await outcome(run((tx) => forge(tx, evidence))), role).toBe(
          "23514:waiver_evidence_signed",
        );
      }

      // An expired session writes nothing (its expiry moved back by the owner, guard off).
      await world.admin.begin(async (tx) => {
        await tx`alter table public.waiver_signing_sessions disable trigger waiver_signing_sessions_check`;
        await tx`update public.waiver_signing_sessions set expires_at = now() - interval '1 minute'
                  where id = ${s2.session.id}`;
        await tx`alter table public.waiver_signing_sessions enable trigger waiver_signing_sessions_check`;
      });
      expect(
        await outcome(
          asApp(world, A.id, async (tx) => {
            await forge(tx, evidence);
            await tx`update public.waiver_requests set state = 'signed' where id = ${r2}`;
          }),
        ),
      ).toBe("23514:waiver_evidence_session");
      expect(await loads(A.id, s2.secret)).toBe(false);

      // Nothing above changed a stored row, apart from the session expiry moved on purpose.
      const after = await fingerprint();
      expect(after.slice(0, 5)).toEqual(before.slice(0, 5));
      const [r2now] = await world.admin<{ state: string; evidence: number }[]>`
        select state, (select count(*)::int from public.waiver_evidence where request_id = ${r2})
                 as evidence from public.waiver_requests where id = ${r2}`;
      expect(r2now).toEqual({ state: "pending", evidence: 0 });

      // The stored PDF is the one its hash names, and its chain leads back to the email.
      const [chain] = await world.admin<
        { document: Buffer; document_sha256: string; recipient_email: string; sent_to: string }[]
      >`select e.document, e.document_sha256, e.recipient_email, d.recipient_email as sent_to
          from public.waiver_evidence e
          join public.waiver_signing_sessions s on s.tenant_id = e.tenant_id and s.id = e.session_id
          join public.guest_access_links l on l.tenant_id = s.tenant_id and l.id = s.access_link_id
          join public.waiver_deliveries d on d.tenant_id = l.tenant_id and d.message_id = l.message_id
         where e.request_id = ${r1} and s.request_id = ${r1}
           and l.subject_ref = ${`waiver_request:${r1}`}`;
      expect(chain?.document_sha256).toBe(
        createHash("sha256")
          .update(chain?.document ?? "")
          .digest("hex"),
      );
      expect(chain?.document.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
      expect(chain?.recipient_email).toBe(chain?.sent_to);
    },
    300_000,
  );
});
