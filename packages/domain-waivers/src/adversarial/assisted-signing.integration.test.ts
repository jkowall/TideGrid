/**
 * W1-G215-SIGNING adversarial: staff-assisted and QR signing (migration 0020),
 * against the waiver contract (packages/domain-waivers/README.md,
 * "Staff-assisted and QR signing").
 *
 * - The booking-source matrix: online and staff-assisted bookings, each
 *   confirmed through the webhook and through the sweep, sign at the dock the
 *   same way, including an adult with no email and a minor's guardian.
 * - Evidence records the mode, staff_confirmed, and the staff member, read
 *   from the session's own link: no writer can claim another method.
 * - Replay and revocation: a code works once, a new start ends the old one,
 *   the emailed link keeps working, and a cancellation, a participant change,
 *   or a new version closes the code.
 * - Two tenants: another operator's request or token is simply not there.
 * - The database: only staff start one, only for a fresh 15-minute link with
 *   no email, and a link with no email opens nothing without that start.
 *
 * All data is synthetic: names are invented, addresses end in .test.
 */
import { createHash, randomUUID } from "node:crypto";
import { inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type BookingHooks,
  ensureProviderPayment,
  handleVerifiedEvent,
  openStaffCheckout,
  sweepCheckouts,
} from "@tidegrid/domain-booking";
import { fakeProvider, verifiedFakeEvent } from "@tidegrid/domain-booking/testing";
import { FAKE_MINIMUM_AMOUNT } from "@tidegrid/domain-payments";
import { createQuote } from "@tidegrid/domain-pricing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createWaiverHooks,
  defaultWaiverDeps,
  endWaiverSession,
  loadEvidenceDocument,
  loadWaiverSession,
  publishWaiverTemplateVersion,
  reassignUnsignedRequests,
  startAssistedSigning,
  type WaiverDeps,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  FIXTURE_TEXT,
  fixtureDeps,
  fixtureHooks,
  minor,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  asApp,
  book,
  closeWorld,
  guestCtx,
  liveRequest,
  name,
  openFor,
  openWorld,
  redeem,
  refusal,
  sign,
  systemCtx,
  trips,
  uniqueEmail,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W1-G215-SIGNING adversarial: staff-assisted and QR signing", () => {
  let world: World;
  let A: WaiverFixture;
  let B: WaiverFixture;
  let nextTrip: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;
  let staffA: string;
  let staffB: string;

  async function addStaff(tenant: WaiverFixture, display: string): Promise<string> {
    const id = randomUUID();
    await world.admin`insert into public.staff_users (id, email, display_name)
      values (${id}, ${`assist-${id.slice(0, 8)}@example.test`}, ${display})`;
    await world.admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenant.id}, ${id}, 'booking_staff', ${display})`;
    return id;
  }

  const staffCtx = (tenantId: string, staffId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: staffId,
    requestId: `assist-${randomUUID()}`,
    sourceIp: null,
  });

  function start(
    tenantId: string,
    staffId: string,
    requestId: string,
    mode: "staff_device" | "participant_qr",
    identityChecked = true,
  ) {
    const ctx = staffCtx(tenantId, staffId);
    return inTenantTransaction(world.db, ctx, (trx) =>
      startAssistedSigning(trx, ctx, deps, { requestId, mode, identityChecked }),
    );
  }

  async function issued(
    tenantId: string,
    staffId: string,
    requestId: string,
    mode: "staff_device" | "participant_qr",
  ) {
    const result = await start(tenantId, staffId, requestId, mode);
    if (result.kind !== "issued") throw new Error(`start: ${JSON.stringify(result)}`);
    return result;
  }

  async function evidenceOf(requestId: string) {
    const [row] = await world.admin<
      {
        access_method: string;
        match_method: string;
        assisted_by: string | null;
        recipient_email: string | null;
        signer_role: string;
        signer_name: string;
        guardian_relationship: string | null;
      }[]
    >`select access_method, match_method, assisted_by, recipient_email, signer_role,
             signer_name, guardian_relationship
        from public.waiver_evidence where request_id = ${requestId}`;
    return row;
  }

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 12);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvsa", { days: 8 });
    B = await createWaiverFixture(world.admin, world.db, "wvsb", { days: 2 });
    nextTrip = trips(A);
    staffA = await addStaff(A, "Dana Dock");
    staffB = await addStaff(B, "Other Desk");
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  it("signs at the dock the same way for online and staff-assisted bookings, through the webhook and the sweep", async () => {
    const provider = fakeProvider(world.db);
    const tripId = nextTrip();

    /** A checkout paid at the fake provider, its event not yet delivered. */
    async function paid(source: "direct" | "staff") {
      if (source === "direct") {
        // The online checkout, confirmed by the harness on the webhook path;
        // for the sweep, the same checkout with a crash before confirmation.
        return null;
      }
      const ctx = staffCtx(A.id, staffA);
      const quoted = await inTenantTransaction(world.db, ctx, (trx) =>
        createQuote(trx, ctx, {
          tripId,
          party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
          addOns: [],
          promotionCode: null,
          now: new Date(),
        }),
      );
      if (quoted.kind !== "created") throw new Error(JSON.stringify(quoted));
      const opened = await inTenantTransaction(world.db, ctx, (trx) =>
        openStaffCheckout(trx, ctx, {
          quoteId: quoted.quote.quoteId,
          acceptedPolicyVersion: quoted.quote.policy.version,
          booker: { name: "Synthetic Caller", email: "synthetic.caller@example.test" },
          channel: "walk_up",
          attestations: { policyToldToGuest: true, emailReadBack: true },
          provider: "fake",
          minimumAmount: FAKE_MINIMUM_AMOUNT,
        }),
      );
      if (opened.kind !== "created") throw new Error(JSON.stringify(opened));
      const ready = await ensureProviderPayment(world.db, provider, ctx, opened.session.id);
      if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
      const settled = await provider.settlePayment(A.id, ready.paymentRef, "succeeded", Date.now());
      if (settled.kind === "not_found") throw new Error("payment did not settle");
      return {
        sessionId: opened.session.id,
        event: await verifiedFakeEvent(provider, settled.event.body),
      };
    }
    const bookingOf = async (sessionId: string) => {
      const [row] = await world.admin<{ id: string; source: string }[]>`
        select id, source from public.bookings where checkout_session_id = ${sessionId}`;
      if (!row) throw new Error(`no booking for ${sessionId}`);
      return row;
    };
    const crash: BookingHooks = {
      async bookingConfirmed() {
        throw new Error("the worker stopped after recording the event");
      },
    };
    const sweep = async () => {
      const report = await sweepCheckouts(world.db, {
        runId: `sweep-${randomUUID()}`,
        provider,
        hooks,
        graceSeconds: 0,
        budgetMs: 90_000,
      });
      expect(report.reprocessed).toBeGreaterThanOrEqual(1);
    };

    // Online, webhook.
    const onlineWebhook = (await book(world, A, tripId, 2, hooks)).bookingId;
    // Staff-assisted, webhook.
    const staffHooked = await paid("staff");
    if (!staffHooked) throw new Error("no staff checkout");
    await handleVerifiedEvent(world.db, provider, staffHooked.event, {
      requestId: `wh-${randomUUID()}`,
      hooks,
    });
    const staffWebhook = await bookingOf(staffHooked.sessionId);
    // Staff-assisted, sweep.
    const staffSwept = await paid("staff");
    if (!staffSwept) throw new Error("no staff checkout");
    await expect(
      handleVerifiedEvent(world.db, provider, staffSwept.event, {
        requestId: `wh-${randomUUID()}`,
        hooks: crash,
      }),
    ).rejects.toThrow(/worker stopped/);
    await sweep();
    const staffSweep = await bookingOf(staffSwept.sessionId);
    // Online, sweep: the harness books through the webhook with a crashing hook,
    // then the sweep confirms it.
    const onlineSwept = await book(world, A, tripId, 2, crash).catch(() => null);
    expect(onlineSwept).toBeNull();
    await sweep();
    const [onlineSweepRow] = await world.admin<{ id: string; source: string }[]>`
      select b.id, b.source from public.bookings b
       where b.trip_id = ${tripId} and b.source = 'direct' and b.id <> ${onlineWebhook}`;
    if (!onlineSweepRow) throw new Error("the sweep confirmed no online booking");
    expect([staffWebhook.source, staffSweep.source, onlineSweepRow.source]).toEqual([
      "staff_assisted",
      "staff_assisted",
      "direct",
    ]);

    const outcomes = [];
    for (const bookingId of [onlineWebhook, onlineSweepRow.id, staffWebhook.id, staffSweep.id]) {
      // An adult with no email (the no-email entry), and a minor with a guardian.
      const noEmail = await name(world, A.id, bookingId, 1, adult("Nell Noemail", null), hooks);
      const kid = await name(
        world,
        A.id,
        bookingId,
        2,
        minor("Kip Dock", { name: "Gwen Dock", email: uniqueEmail("gwen-dock") }),
        hooks,
      );
      const adultReq = (await liveRequest(world.admin, bookingId, noEmail)).id;
      const kidReq = (await liveRequest(world.admin, bookingId, kid)).id;

      const device = await issued(A.id, staffA, adultReq, "staff_device");
      const opened = await redeem(world, A.id, device.token);
      if (opened.kind !== "opened") throw new Error(JSON.stringify(opened));
      expect(opened.session.access).toBe("staff_device");
      expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");

      const qr = await issued(A.id, staffA, kidReq, "participant_qr");
      const openedQr = await redeem(world, A.id, qr.token);
      if (openedQr.kind !== "opened") throw new Error(JSON.stringify(openedQr));
      expect(
        (
          await sign(world, A.id, deps, openedQr.session, {
            signature: "Gwen Dock",
            relationship: "legal_guardian",
          })
        ).kind,
      ).toBe("signed");
      outcomes.push([await evidenceOf(adultReq), await evidenceOf(kidReq)]);
    }
    for (const outcome of outcomes) {
      expect(outcome).toEqual([
        {
          access_method: "staff_device",
          match_method: "staff_confirmed",
          assisted_by: staffA,
          recipient_email: null,
          signer_role: "participant",
          signer_name: "Nell Noemail",
          guardian_relationship: null,
        },
        {
          access_method: "participant_qr",
          match_method: "staff_confirmed",
          assisted_by: staffA,
          recipient_email: null,
          signer_role: "guardian",
          signer_name: "Gwen Dock",
          guardian_relationship: "legal_guardian",
        },
      ]);
    }
  }, 300_000);

  it("works once, ends the earlier code, keeps the emailed link, and lasts 15 minutes", async () => {
    const booked = await book(world, A, nextTrip(), 2, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Rae Replay"), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;

    const first = await issued(A.id, staffA, req, "participant_qr");
    const second = await issued(A.id, staffA, req, "participant_qr");
    expect(first.token).not.toBe(second.token);
    expect(await redeem(world, A.id, first.token)).toEqual({ kind: "replaced" });
    const [lifetimes] = await world.admin<{ link: number }[]>`
      select extract(epoch from (expires_at - created_at))::int as link
        from public.guest_access_links where id = ${second.linkId}`;
    expect(lifetimes?.link).toBeLessThanOrEqual(15 * 60);

    const opened = await redeem(world, A.id, second.token);
    if (opened.kind !== "opened") throw new Error(JSON.stringify(opened));
    expect(await redeem(world, A.id, second.token)).toEqual({ kind: "used" });
    const [session] = await world.admin<{ seconds: number }[]>`
      select extract(epoch from (expires_at - created_at))::int as seconds
        from public.waiver_signing_sessions where id = ${opened.session.id}`;
    expect(session?.seconds).toBeLessThanOrEqual(15 * 60);

    // The emailed link still works: a staff start never touches it.
    const fromEmail = await openFor(world, A.id, req);
    expect(fromEmail.session.access).toBe("email_link");
    expect((await sign(world, A.id, deps, fromEmail.session)).kind).toBe("signed");
    expect(await evidenceOf(req)).toMatchObject({
      access_method: "email_link",
      match_method: "signer_confirmed",
      assisted_by: null,
    });
    // Signed: the dock session closes, and nothing more starts.
    expect(await loadSessionFor(opened.secret)).toBeNull();
    expect(await start(A.id, staffA, req, "staff_device")).toEqual({ kind: "not_pending" });
  }, 120_000);

  async function loadSessionFor(secret: string) {
    return inTenantTransaction(world.db, guestCtx(A.id), (trx) =>
      loadWaiverSession(trx, A.id, secret),
    );
  }

  it("closes the code when the booking is canceled, the participant changes, or a new version supersedes it", async () => {
    // Canceled.
    const canceled = await book(world, A, nextTrip(), 1, hooks);
    const cp = await name(world, A.id, canceled.bookingId, 1, adult("Cal Canceled"), hooks);
    const creq = (await liveRequest(world.admin, canceled.bookingId, cp)).id;
    const ccode = await issued(A.id, staffA, creq, "staff_device");
    // The booking module runs bookingCanceled in its cancellation.
    const cctx = systemCtx(A.id, "cancellation");
    await inTenantTransaction(
      world.db,
      cctx,
      (trx) =>
        createWaiverHooks(defaultWaiverDeps).bookingCanceled?.(trx, cctx, {
          bookingId: canceled.bookingId,
          cancellationId: randomUUID(),
          refundId: null,
        }) ?? Promise.resolve(),
    );
    expect(await redeem(world, A.id, ccode.token)).toEqual({ kind: "closed", state: "revoked" });

    // A participant who becomes a minor needs another signer.
    const changed = await book(world, A, nextTrip(), 1, hooks);
    const chp = await name(world, A.id, changed.bookingId, 1, adult("Mo Changed"), hooks);
    const chreq = (await liveRequest(world.admin, changed.bookingId, chp)).id;
    const chcode = await issued(A.id, staffA, chreq, "participant_qr");
    const chopen = await redeem(world, A.id, chcode.token);
    if (chopen.kind !== "opened") throw new Error(JSON.stringify(chopen));
    await name(
      world,
      A.id,
      changed.bookingId,
      1,
      minor("Mo Changed", { name: "Pat Changed", email: uniqueEmail("pat") }),
      hooks,
    );
    expect(await loadSessionFor(chopen.secret)).toBeNull();
    expect(await start(A.id, staffA, chreq, "staff_device")).toEqual({ kind: "not_pending" });

    // A new version moves unsigned work: the code for the old request opens nothing.
    const moved = await book(world, A, nextTrip(), 1, hooks);
    const mp = await name(world, A.id, moved.bookingId, 1, adult("Vi Version"), hooks);
    const mreq = (await liveRequest(world.admin, moved.bookingId, mp)).id;
    const mcode = await issued(A.id, staffA, mreq, "staff_device");
    const sctx = systemCtx(A.id);
    const published = await inTenantTransaction(world.db, sctx, (trx) =>
      publishWaiverTemplateVersion(trx, sctx, {
        templateId: A.templateId,
        text: { ...FIXTURE_TEXT, body: `${FIXTURE_TEXT.body}\n\nVersion two.` },
        reason: "assisted test",
      }),
    );
    expect(published.kind).toBe("published");
    await reassignUnsignedRequests(world.db, sctx, deps, { templateId: A.templateId, version: 2 });
    expect(await redeem(world, A.id, mcode.token)).toEqual({
      kind: "closed",
      state: "superseded",
    });
  }, 180_000);

  it("refuses an unchecked identity, a non-staff caller, and another operator's request or code", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Ty Tenant"), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    expect(await start(A.id, staffA, req, "staff_device", false)).toEqual({
      kind: "identity_unchecked",
    });
    const sctx = systemCtx(A.id);
    await expect(
      inTenantTransaction(world.db, sctx, (trx) =>
        startAssistedSigning(trx, sctx, deps, {
          requestId: req,
          mode: "staff_device",
          identityChecked: true,
        }),
      ),
    ).rejects.toThrow(/only a staff member/);
    // Another operator's staff: the request is not there.
    expect(await start(B.id, staffB, req, "staff_device")).toEqual({ kind: "not_found" });
    // Another operator's site: the code is not there, and stays unused.
    const code = await issued(A.id, staffA, req, "participant_qr");
    expect(await redeem(world, B.id, code.token)).toEqual({ kind: "invalid" });
    const opened = await redeem(world, A.id, code.token);
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;
    // Another operator's session reads nothing.
    expect(
      await inTenantTransaction(world.db, guestCtx(B.id), (trx) =>
        loadWaiverSession(trx, B.id, opened.secret),
      ),
    ).toBeNull();
  }, 120_000);

  it("ends a session from its own page and keeps the evidence for staff", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Sid Signout"), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const code = await issued(A.id, staffA, req, "staff_device");
    const opened = await redeem(world, A.id, code.token);
    if (opened.kind !== "opened") throw new Error(JSON.stringify(opened));
    expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");
    const gctx = guestCtx(A.id);
    expect(
      await inTenantTransaction(world.db, gctx, (trx) =>
        endWaiverSession(trx, gctx, opened.session),
      ),
    ).toBe(true);
    expect(await loadSessionFor(opened.secret)).toBeNull();
    const [row] = await world.admin<{ revoked_reason: string }[]>`
      select revoked_reason from public.waiver_signing_sessions where id = ${opened.session.id}`;
    expect(row?.revoked_reason).toBe("signed_out");
    const doc = await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
      loadEvidenceDocument(trx, A.id, { requestId: req }),
    );
    expect(doc?.document.byteLength).toBeGreaterThan(64);
    expect(Buffer.from(doc?.document ?? []).toString("latin1")).toContain("Assisted by");
    expect(Buffer.from(doc?.document ?? []).toString("latin1")).toContain("Dana Dock");
  }, 120_000);

  it("holds the rules at the database for every writer", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Dee Database"), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const subject = `waiver_request:${req}`;
    // A fresh hex hash for each name, so reruns never collide on the unique key.
    const hash = (_label: string) => createHash("sha256").update(randomUUID()).digest("hex");
    const link = (tx: Parameters<Parameters<typeof asApp>[2]>[0], h: string, minutes = 10) => tx`
      insert into public.guest_access_links (tenant_id, booking_id, participant_id, purpose,
        subject_ref, token_hash, expires_at)
      values (${A.id}, ${booked.bookingId}, ${pid}, 'waiver_sign', ${subject}, ${h},
              now() + make_interval(mins => ${minutes}))
      returning id`;
    const assisted = (tx: Parameters<Parameters<typeof asApp>[2]>[0], linkId: string) => tx`
      insert into public.waiver_assisted_links (tenant_id, access_link_id, request_id,
        booking_id, participant_id, mode, identity_checked)
      values (${A.id}, ${linkId}, ${req}, ${booked.bookingId}, ${pid}, 'staff_device', true)`;
    const asStaff = <T>(fn: (tx: Parameters<Parameters<typeof asApp>[2]>[0]) => Promise<T>) =>
      world.app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${A.id}, true),
                        set_config('app.actor_type', 'staff', true),
                        set_config('app.actor_id', ${staffA}, true)`;
        return fn(tx as never);
      });

    // Not staff.
    expect(
      await refusal(
        asApp(world, A.id, async (tx) => {
          const [l] = await link(tx, hash("a"));
          await assisted(tx, l?.id);
        }),
      ),
    ).toBe("23514:waiver_assisted_links_actor");
    // A link longer than 15 minutes.
    expect(
      await refusal(
        asStaff(async (tx) => {
          const [l] = await link(tx, hash("b"), 60);
          await assisted(tx, l?.id);
        }),
      ),
    ).toBe("23514:waiver_assisted_links_link");
    // A link written earlier (an email's, or one an attacker kept).
    const [old] = await asApp(world, A.id, (tx) => link(tx, hash("c")));
    expect(await refusal(asStaff((tx) => assisted(tx, old?.id)))).toBe(
      "23514:waiver_assisted_links_link",
    );
    // A link with no email and no staff start opens no session.
    expect(
      await refusal(
        asApp(world, A.id, async (tx) => {
          await tx`update public.guest_access_links set consumed_at = now() where id = ${old?.id}`;
          await tx`insert into public.waiver_signing_sessions (tenant_id, access_link_id, request_id,
              booking_id, participant_id, purpose, signer_role, secret_hash, expires_at)
            values (${A.id}, ${old?.id}, ${req}, ${booked.bookingId}, ${pid}, 'sign', 'participant',
                    ${hash("d")}, now() + interval '10 minutes')`;
        }),
      ),
    ).toBe("23514:waiver_signing_sessions_assisted");
    // A staff start's session longer than 15 minutes.
    expect(
      await refusal(
        asStaff(async (tx) => {
          const [l] = await link(tx, hash("e"));
          await assisted(tx, l?.id);
          await tx`update public.guest_access_links set consumed_at = now() where id = ${l?.id}`;
          await tx`insert into public.waiver_signing_sessions (tenant_id, access_link_id, request_id,
              booking_id, participant_id, purpose, signer_role, secret_hash, expires_at)
            values (${A.id}, ${l?.id}, ${req}, ${booked.bookingId}, ${pid}, 'sign', 'participant',
                    ${hash("f")}, now() + interval '30 minutes')`;
        }),
      ),
    ).toBe("23514:waiver_signing_sessions_assisted");
    // Append-only.
    await asStaff(async (tx) => {
      const [l] = await link(tx, hash("g"));
      await assisted(tx, l?.id);
    });
    for (const statement of [
      "update public.waiver_assisted_links set mode = 'participant_qr'",
      "delete from public.waiver_assisted_links",
    ]) {
      expect(await refusal(asApp(world, A.id, (tx) => tx.unsafe(statement)))).toMatch(
        /^(23514|42501)/,
      );
    }
    // Another tenant's rows are invisible.
    const seen = await world.app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${B.id}, true)`;
      return tx`select count(*)::int as n from public.waiver_assisted_links`;
    });
    expect(seen[0]?.n).toBe(0);
  }, 120_000);
});
