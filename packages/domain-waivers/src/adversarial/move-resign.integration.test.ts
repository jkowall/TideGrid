/**
 * W3-G2.15-rest: a signed waiver carries over a booking move only while its
 * version still applies (owner decision 2026-11-13). On the local PostgreSQL
 * 17 container (TIDEGRID_EPHEMERAL_DB=1), synthetic data only.
 */
import { inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { type BookingHooks, rescheduleBooking } from "@tidegrid/domain-booking";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  listBookingWaivers,
  publishWaiverTemplateVersion,
  revokeStaleSignatures,
  type WaiverDeps,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  FIXTURE_TEXT,
  fixtureDeps,
  fixtureHooks,
  staffContext,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  book,
  closeWorld,
  liveRequest,
  name,
  openFor,
  openWorld,
  refusal,
  sign,
  trips,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W3-G2.15-rest: waiver signatures on a moved booking", () => {
  let world: World;
  let A: WaiverFixture;
  let nextTrip: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;
  let revisions = 0;

  const staff = (tenantId: string): TenantContext => staffContext(tenantId, "move-resign");

  function move(bookingId: string, fromTripId: string, toTripId: string, withHooks = hooks) {
    const ctx = staff(A.id);
    return inTenantTransaction(world.db, ctx, (trx) =>
      rescheduleBooking(trx, ctx, { bookingId, fromTripId, toTripId, hooks: withHooks }),
    );
  }

  async function publishRevision() {
    const ctx = staff(A.id);
    revisions += 1;
    const published = await inTenantTransaction(world.db, ctx, (trx) =>
      publishWaiverTemplateVersion(trx, ctx, {
        templateId: A.templateId,
        text: { ...FIXTURE_TEXT, body: `${FIXTURE_TEXT.body}\n\nRevision ${revisions}.` },
        reason: "Synthetic revision",
      }),
    );
    if (published.kind !== "published") throw new Error(JSON.stringify(published));
    return published.version;
  }

  async function requests(bookingId: string) {
    return world.admin<
      {
        id: string;
        participant_id: string;
        state: string;
        revoked_reason: string | null;
        template_version: number;
      }[]
    >`select id, participant_id, state, revoked_reason, template_version
        from public.waiver_requests where booking_id = ${bookingId} order by created_at, id`;
  }

  /** A booking of one named adult who has signed, on the first of two trips. */
  async function signedBooking(label: string) {
    const from = nextTrip();
    const to = nextTrip();
    const booked = await book(world, A, from, 1, hooks);
    const pid = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult(label, `${label}@example.test`),
      hooks,
    );
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const opened = await openFor(world, A.id, req);
    expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");
    return { booked, pid, req, from, to };
  }

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 8);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvmv", { days: 16 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  it("keeps a signature on the version that still applies", async () => {
    const { booked, req, from, to } = await signedBooking("kept.signer");
    expect((await move(booked.bookingId, from, to)).kind).toBe("moved");
    expect(await requests(booked.bookingId)).toMatchObject([{ id: req, state: "signed" }]);
  });

  it("asks for the new version when the operator published one since the signature", async () => {
    const { booked, pid, req, from, to } = await signedBooking("resign.signer");
    const version = await publishRevision();
    expect((await move(booked.bookingId, from, to)).kind).toBe("moved");
    const rows = await requests(booked.bookingId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: req, state: "revoked", revoked_reason: "version_changed" });
    expect(rows[1]).toMatchObject({
      participant_id: pid,
      state: "pending",
      template_version: version,
    });
    const ctx = staff(A.id);
    const listed = await inTenantTransaction(world.db, ctx, (trx) =>
      listBookingWaivers(trx, ctx.tenantId, booked.bookingId),
    );
    expect(listed?.participants[0]?.status).not.toBe("signed");
    // Its email went out for the new request.
    const [queued] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.waiver_deliveries where request_id = ${rows[1]?.id ?? ""}`;
    expect(queued?.n).toBe(1);
    // The evidence of the first signature is kept.
    const [evidence] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.waiver_evidence where request_id = ${req}`;
    expect(evidence?.n).toBe(1);
  });

  it("replaces an unsigned request on an old version, so the old text can no longer be signed", async () => {
    const from = nextTrip();
    const to = nextTrip();
    const booked = await book(world, A, from, 2, hooks);
    const signer = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("pair.signed", "pair.signed@example.test"),
      hooks,
    );
    const waiting = await name(
      world,
      A.id,
      booked.bookingId,
      2,
      adult("pair.pending", "pair.pending@example.test"),
      hooks,
    );
    const signedReq = (await liveRequest(world.admin, booked.bookingId, signer)).id;
    const signedOpen = await openFor(world, A.id, signedReq);
    expect((await sign(world, A.id, deps, signedOpen.session)).kind).toBe("signed");
    const pendingReq = (await liveRequest(world.admin, booked.bookingId, waiting)).id;
    // The second person has the old text open on their phone during the move.
    const pendingOpen = await openFor(world, A.id, pendingReq);
    const version = await publishRevision();
    expect((await move(booked.bookingId, from, to)).kind).toBe("moved");
    const rows = await requests(booked.bookingId);
    expect(rows.find((r) => r.id === signedReq)).toMatchObject({
      state: "revoked",
      revoked_reason: "version_changed",
    });
    expect(rows.find((r) => r.id === pendingReq)).toMatchObject({ state: "superseded" });
    const live = rows.filter((r) => r.state === "pending");
    expect(live.map((r) => r.participant_id).sort()).toEqual([signer, waiting].sort());
    expect(live.every((r) => r.template_version === version)).toBe(true);
    expect((await sign(world, A.id, deps, pendingOpen.session)).kind).not.toBe("signed");
    expect((await requests(booked.bookingId)).filter((r) => r.state === "signed")).toHaveLength(0);
    const [queued] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.waiver_deliveries
       where request_id in ${world.admin(live.map((r) => r.id))}`;
    expect(queued?.n).toBe(2);
  });

  it("moves without the waiver hooks leave signatures alone, and nothing ends one without a move", async () => {
    const { booked, pid, req, from, to } = await signedBooking("nohook.signer");
    await publishRevision();
    // Ending a signature for a changed version outside a move is refused by the database.
    const ctx = staff(A.id);
    expect(
      await refusal(
        inTenantTransaction(world.db, ctx, (trx) =>
          revokeStaleSignatures(trx, ctx, { bookingId: booked.bookingId, participantIds: [pid] }),
        ),
      ),
    ).toBe("23514:waiver_requests_version_changed");
    expect((await move(booked.bookingId, from, to, {})).kind).toBe("moved");
    expect(await requests(booked.bookingId)).toMatchObject([{ id: req, state: "signed" }]);
  });

  it("a move committed by another transaction meanwhile does not let this one end a signature", async () => {
    const { booked, pid, from, to } = await signedBooking("other.tx.signer");
    await publishRevision();
    const ctx = staff(A.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const outcome = refusal(
      inTenantTransaction(world.db, ctx, async (trx) => {
        await listBookingWaivers(trx, ctx.tenantId, booked.bookingId);
        started();
        await gate;
        return revokeStaleSignatures(trx, ctx, {
          bookingId: booked.bookingId,
          participantIds: [pid],
        });
      }),
    );
    await begun;
    expect((await move(booked.bookingId, from, to, {})).kind).toBe("moved");
    release();
    expect(await outcome).toBe("23514:waiver_requests_version_changed");
  });

  it("a move never ends a signature on the version still in effect", async () => {
    const { booked, pid, from, to } = await signedBooking("current.signer");
    const forcing: BookingHooks = {
      async bookingRescheduled(trx, ctx, event) {
        await revokeStaleSignatures(trx, ctx, {
          bookingId: event.bookingId,
          participantIds: [pid],
        });
      },
    };
    expect(await refusal(move(booked.bookingId, from, to, forcing))).toBe(
      "23514:waiver_requests_version_changed",
    );
  });

  it("never ends a pending request as a changed version", async () => {
    const from = nextTrip();
    const booked = await book(world, A, from, 1, hooks);
    const pid = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("pending.one", "pending.one@example.test"),
      hooks,
    );
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    expect(
      await refusal(
        world.admin`update public.waiver_requests set state = 'revoked', revoked_reason = 'version_changed'
                     where id = ${req}`,
      ),
    ).toBe("23514:waiver_requests_version_changed");
  });
});
