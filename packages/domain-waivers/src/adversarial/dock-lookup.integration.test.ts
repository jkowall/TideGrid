/**
 * W3-G2.15-rest: the generic dock QR (owner decision 2026-11-13, migration
 * 0043). A booking code and the booker's last name find that booking's own
 * party for a trip departing today; tries are limited; a match starts a
 * signing on the guest's own phone. On the local PostgreSQL 17 container
 * (TIDEGRID_EPHEMERAL_DB=1), synthetic data only.
 */
import { randomUUID } from "node:crypto";
import { inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { lookUpAtDock, startAssistedSigning, startDockSigning, type WaiverDeps } from "../index.ts";
import {
  adult,
  createWaiverFixture,
  fixtureDeps,
  fixtureHooks,
  minor,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  asApp,
  book,
  closeWorld,
  liveRequest,
  name,
  openWorld,
  redeem,
  refusal,
  sign,
  trips,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W3-G2.15-rest: the dock QR lookup", () => {
  let world: World;
  let A: WaiverFixture;
  let B: WaiverFixture;
  let nextA: () => string;
  let nextB: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;
  let ipCounter = 0;

  /** A guest at a fresh client address, unless one is given. */
  function guest(tenantId: string, ip?: string): TenantContext {
    ipCounter += 1;
    return {
      tenantId,
      actorType: "guest",
      actorId: null,
      requestId: `dock-${randomUUID()}`,
      sourceIp: ip ?? `203.0.113.${ipCounter % 250}`,
    };
  }

  function lookUp(tenantId: string, bookingCode: string, lastName: string, ip?: string) {
    const ctx = guest(tenantId, ip);
    return inTenantTransaction(world.db, ctx, (trx) =>
      lookUpAtDock(trx, ctx, { bookingCode, lastName }),
    );
  }

  function startSigning(tenantId: string, secret: string, position: number) {
    const ctx = guest(tenantId);
    return inTenantTransaction(world.db, ctx, (trx) =>
      startDockSigning(trx, ctx, deps, { secret, position }),
    );
  }

  /**
   * Move a trip to depart a minute ago, on a boat of its own so it meets no
   * other departure: today, in its own time zone, and not over. The admin,
   * with the schedule trigger off, as the reminder suite does.
   */
  async function departingNow(tripId: string) {
    await world.admin.begin(async (tx) => {
      await tx`alter table public.scheduled_trips disable trigger scheduled_trips_consistency`;
      const [boat] = await tx<{ id: string }[]>`
        insert into public.boats (tenant_id, name, guest_capacity)
        select b.tenant_id, ${`Dock ${randomUUID().slice(0, 8)}`}, b.guest_capacity
          from public.scheduled_trips t join public.boats b on b.tenant_id = t.tenant_id and b.id = t.boat_id
         where t.id = ${tripId}
        returning id`;
      await tx`insert into public.product_boats (tenant_id, product_id, boat_id)
               select tenant_id, product_id, ${boat?.id ?? ""} from public.scheduled_trips
                where id = ${tripId}`;
      await tx`update public.scheduled_trips
                  set boat_id = ${boat?.id ?? ""}, schedule_id = null,
                      boat_free_at = now() - interval '1 minute' + (boat_free_at - starts_at),
                      ends_at = now() - interval '1 minute' + (ends_at - starts_at),
                      starts_at = now() - interval '1 minute'
                where id = ${tripId}`;
      await tx`alter table public.scheduled_trips enable trigger scheduled_trips_consistency`;
    });
  }

  /** A booking of two named people (an adult and a minor), departing today. */
  async function todaysBooking(label: string) {
    const tripId = nextA();
    const booked = await book(world, A, tripId, 3, hooks);
    const p1 = await name(world, A.id, booked.bookingId, 1, adult(`Ana ${label}`), hooks);
    const p2 = await name(
      world,
      A.id,
      booked.bookingId,
      2,
      minor(`Kid ${label}`, { name: `Ana ${label}`, email: `ana.${label}@example.test` }),
      hooks,
    );
    await departingNow(tripId);
    return { booked, tripId, p1, p2 };
  }

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 8);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "dock", { days: 14 });
    B = await createWaiverFixture(world.admin, world.db, "dockb", { days: 4 });
    nextA = trips(A);
    nextB = trips(B);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  it("finds today's booking by its code and the booker's last name, and shows only its party", async () => {
    const { booked } = await todaysBooking("Match");
    // The fixture's booker is "Synthetic Booker"; case, dashes, and look-alikes are forgiven.
    const code = booked.reference.toLowerCase().replace(/^(....)/, "$1-");
    const found = await lookUp(A.id, code, "  BOOKER ");
    expect(found.kind).toBe("matched");
    if (found.kind !== "matched") return;
    expect(found.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(found.party.people).toEqual([
      { position: 1, name: "Ana M.", minor: false, status: "to_sign", signer: "participant" },
      { position: 2, name: "Kid M.", minor: true, status: "to_sign", signer: "guardian" },
    ]);
    // Nothing but first names and an initial: no address, no ids.
    const text = JSON.stringify(found.party);
    expect(text).not.toContain("@");
    expect(text).not.toContain(booked.bookingId);
    // The try is recorded with the code, never the name.
    const [row] = await world.admin<
      { matched: boolean; reference_key: string; client_key: string }[]
    >`
      select matched, reference_key, client_key from public.waiver_dock_lookups
       where booking_id = ${booked.bookingId}`;
    expect(row).toMatchObject({ matched: true, reference_key: booked.reference });
  });

  it("answers every miss the same: wrong name, another day, canceled, another operator", async () => {
    const { booked } = await todaysBooking("Miss");
    expect(await lookUp(A.id, booked.reference, "Bookerson")).toEqual({ kind: "not_found" });
    expect(await lookUp(A.id, booked.reference, "B")).toEqual({ kind: "not_found" });
    expect(await lookUp(A.id, booked.reference, "Synthetic Booker")).toEqual({ kind: "not_found" });
    // Another operator's host does not find A's booking.
    expect(await lookUp(B.id, booked.reference, "Booker")).toEqual({ kind: "not_found" });
    // A trip tomorrow is not today's.
    const later = await book(world, A, nextA(), 1, hooks);
    expect(await lookUp(A.id, later.reference, "Booker")).toEqual({ kind: "not_found" });
    // An unreadable code is refused without counting.
    expect(await lookUp(A.id, "#!?", "Booker")).toEqual({ kind: "invalid" });
  });

  it("starts a signing on the guest's phone, and the evidence records the dock lookup", async () => {
    const { booked, p1 } = await todaysBooking("Sign");
    const found = await lookUp(A.id, booked.reference, "Booker");
    if (found.kind !== "matched") throw new Error(found.kind);
    const started = await startSigning(A.id, found.secret, 1);
    expect(started.kind).toBe("issued");
    if (started.kind !== "issued") return;
    const token = started.path.split("#t=")[1] ?? "";
    const opened = await redeem(world, A.id, token);
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;
    expect(opened.session.access).toBe("dock_lookup");
    expect(opened.session.participantId).toBe(p1);
    expect((await sign(world, A.id, deps, opened.session)).kind).toBe("signed");
    const [evidence] = await world.admin<
      {
        access_method: string;
        match_method: string;
        assisted_by: string | null;
        recipient_email: string | null;
      }[]
    >`select access_method, match_method, assisted_by, recipient_email from public.waiver_evidence
       where booking_id = ${booked.bookingId} and participant_id = ${p1}`;
    expect(evidence).toEqual({
      access_method: "dock_lookup",
      match_method: "booking_lookup",
      assisted_by: null,
      recipient_email: null,
    });
    // The audit log says the same as the evidence.
    const [audit] = await world.admin<{ after: Record<string, unknown> }[]>`
      select after_state as after from public.audit_events
       where tenant_id = ${A.id} and action = 'waiver_request.signed'
         and subject_id = ${opened.session.requestId}`;
    expect(audit?.after).toMatchObject({
      accessMethod: "dock_lookup",
      matchMethod: "booking_lookup",
      assistedBy: null,
    });
    // Nobody checked who signs at the dock, and the row says so.
    const [assisted] = await world.admin<{ identity_checked: boolean }[]>`
      select identity_checked from public.waiver_assisted_links
       where booking_id = ${booked.bookingId} and mode = 'dock_lookup'`;
    expect(assisted?.identity_checked).toBe(false);
    // The party now shows the signature, and a signed person starts nothing.
    const again = await lookUp(A.id, booked.reference, "Booker");
    if (again.kind !== "matched") throw new Error(again.kind);
    expect(again.party.people[0]?.status).toBe("signed");
    expect(await startSigning(A.id, again.secret, 1)).toEqual({ kind: "not_pending" });
    expect(await startSigning(A.id, again.secret, 9)).toEqual({ kind: "not_pending" });
    // A secret from another operator's host opens nothing.
    expect(await startSigning(B.id, again.secret, 2)).toEqual({ kind: "lookup_ended" });
  });

  it("a newer dock code replaces the earlier one for the same person", async () => {
    const { booked, p2 } = await todaysBooking("Twice");
    const found = await lookUp(A.id, booked.reference, "Booker");
    if (found.kind !== "matched") throw new Error(found.kind);
    const first = await startSigning(A.id, found.secret, 2);
    const second = await startSigning(A.id, found.secret, 2);
    if (first.kind !== "issued" || second.kind !== "issued") throw new Error("not issued");
    expect(await redeem(world, A.id, first.path.split("#t=")[1] ?? "")).toEqual({
      kind: "code_ended",
    });
    expect((await redeem(world, A.id, second.path.split("#t=")[1] ?? "")).kind).toBe("opened");
    // The emailed request is untouched: still one live request.
    expect((await liveRequest(world.admin, booked.bookingId, p2)).state).toBe("pending");
  });

  it("limits misses from one address, even before a right answer", async () => {
    const { booked } = await todaysBooking("Client");
    const ip = "192.0.2.10";
    for (let i = 0; i < 20; i++) {
      expect(await lookUp(A.id, `ZZZZZZ${String(i).padStart(2, "0")}`, "Nobody", ip)).toEqual({
        kind: "not_found",
      });
    }
    expect(await lookUp(A.id, booked.reference, "Booker", ip)).toEqual({ kind: "limited" });
    // Another address is not held.
    expect((await lookUp(A.id, booked.reference, "Booker")).kind).toBe("matched");
  });

  it("counts an IPv6 address by its /64, so rotating through one network gains nothing", async () => {
    const { booked } = await todaysBooking("Six");
    for (let i = 0; i < 20; i++) {
      expect(
        await lookUp(
          A.id,
          `YYYYYY${String(i).padStart(2, "0")}`,
          "Nobody",
          `2001:db8:0:7::${i + 1}`,
        ),
      ).toEqual({ kind: "not_found" });
    }
    expect(await lookUp(A.id, booked.reference, "Booker", "2001:db8:0:7::ffff")).toEqual({
      kind: "limited",
    });
    expect((await lookUp(A.id, booked.reference, "Booker", "2001:db8:0:8::1")).kind).toBe(
      "matched",
    );
    // IPv4 addresses that IPv6 carries stay whole.
    const [keys] = await world.admin<{ k: string }[]>`
      select string_agg(distinct client_key, ',') as k from public.waiver_dock_lookups
       where client_key like '2001:db8:0:7%'`;
    expect(keys?.k).toBe("2001:db8:0:7::/64");
  });

  it("an operator-wide run of misses holds misses only, never a right code and name", async () => {
    const tripId = nextB();
    const booked = await book(world, B, tripId, 1, hooks);
    await name(world, B.id, booked.bookingId, 1, adult("Busy Dock"), hooks);
    await departingNow(tripId);
    const [before] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.waiver_dock_lookups where tenant_id = ${B.id} and not matched`;
    for (let i = before?.n ?? 0; i < 300; i++) {
      const ip = `198.18.${Math.floor(i / 15)}.1`;
      const found = await lookUp(B.id, `XX${String(i).padStart(6, "0")}`, "Nobody", ip);
      expect(found.kind).toBe("not_found");
    }
    expect(await lookUp(B.id, "XXWWWWWW", "Nobody", "198.18.99.1")).toEqual({ kind: "limited" });
    expect((await lookUp(B.id, booked.reference, "Booker", "198.18.99.2")).kind).toBe("matched");
  });

  it("a dock start never ends the crew's signing, and waits while it is live", async () => {
    const { booked, p1 } = await todaysBooking("Crew");
    const staffId = randomUUID();
    await world.admin`insert into public.staff_users (id, email, display_name)
      values (${staffId}, ${`dock-${staffId.slice(0, 8)}@example.test`}, 'Crew Member')`;
    await world.admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${A.id}, ${staffId}, 'booking_staff', 'Crew Member')`;
    const request = await liveRequest(world.admin, booked.bookingId, p1);
    const staff: TenantContext = {
      tenantId: A.id,
      actorType: "staff",
      actorId: staffId,
      requestId: `dock-${randomUUID()}`,
      sourceIp: null,
    };
    const crew = await inTenantTransaction(world.db, staff, (trx) =>
      startAssistedSigning(trx, staff, deps, {
        requestId: request.id,
        mode: "staff_device",
        identityChecked: true,
      }),
    );
    if (crew.kind !== "issued") throw new Error(crew.kind);
    const found = await lookUp(A.id, booked.reference, "Booker");
    if (found.kind !== "matched") throw new Error(found.kind);
    // An unused crew code is live: the dock waits, and the code still works.
    expect(await startSigning(A.id, found.secret, 1)).toEqual({ kind: "crew_signing" });
    const opened = await redeem(world, A.id, crew.token);
    expect(opened.kind).toBe("opened");
    // The crew's open session is live too.
    expect(await startSigning(A.id, found.secret, 1)).toEqual({ kind: "crew_signing" });
    const [session] = await world.admin<{ revoked_at: Date | null }[]>`
      select s.revoked_at from public.waiver_signing_sessions s
       where s.access_link_id = ${crew.linkId}`;
    expect(session?.revoked_at).toBeNull();
    // Another person of the party is not held up.
    expect((await startSigning(A.id, found.secret, 2)).kind).toBe("issued");
  });

  it("a lookup ends when its trip no longer departs today", async () => {
    const { booked, tripId } = await todaysBooking("Moved");
    const found = await lookUp(A.id, booked.reference, "Booker");
    if (found.kind !== "matched") throw new Error(found.kind);
    await world.admin.begin(async (tx) => {
      await tx`alter table public.scheduled_trips disable trigger scheduled_trips_consistency`;
      await tx`update public.scheduled_trips
                  set starts_at = starts_at + interval '2 days', ends_at = ends_at + interval '2 days',
                      boat_free_at = boat_free_at + interval '2 days'
                where id = ${tripId}`;
      await tx`alter table public.scheduled_trips enable trigger scheduled_trips_consistency`;
    });
    expect(await startSigning(A.id, found.secret, 1)).toEqual({ kind: "lookup_ended" });
  });

  it("limits misses on one booking code from many addresses", async () => {
    const { booked } = await todaysBooking("Code");
    for (let i = 0; i < 8; i++) {
      expect(await lookUp(A.id, booked.reference, `Wrong${i}`)).toEqual({ kind: "not_found" });
    }
    expect(await lookUp(A.id, booked.reference, "Booker")).toEqual({ kind: "limited" });
  });

  it("the database holds the rules for every writer", async () => {
    const tripId = nextB();
    const booked = await book(world, B, tripId, 1, hooks);
    await name(world, B.id, booked.bookingId, 1, adult("Rule Keeper"), hooks);
    const asGuest = (sql: (tx: Parameters<Parameters<typeof asApp>[2]>[0]) => Promise<unknown>) =>
      world.app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${B.id}, true),
                        set_config('app.actor_type', 'guest', true),
                        set_config('app.source_ip', '198.51.100.99', true)`;
        return sql(tx as never);
      });
    const secretHash = "a".repeat(64);
    // A match for a trip that does not depart today.
    expect(
      await refusal(
        asGuest(
          (
            tx,
          ) => tx`insert into public.waiver_dock_lookups (reference_key, matched, booking_id, secret_hash)
                     values (${booked.reference}, true, ${booked.bookingId}, ${secretHash})`,
        ),
      ),
    ).toBe("23514:waiver_dock_lookups_booking");
    await departingNow(tripId);
    // A match under the wrong code.
    expect(
      await refusal(
        asGuest(
          (
            tx,
          ) => tx`insert into public.waiver_dock_lookups (reference_key, matched, booking_id, secret_hash)
                     values ('00000000', true, ${booked.bookingId}, ${secretHash})`,
        ),
      ),
    ).toBe("23514:waiver_dock_lookups_booking");
    // Not a guest.
    expect(
      await refusal(
        asApp(
          world,
          B.id,
          (tx) => tx`insert into public.waiver_dock_lookups (reference_key, matched)
                     values ('00000000', false)`,
        ),
      ),
    ).toBe("23514:waiver_dock_lookups_actor");
    // Append-only.
    const [row] = await world.admin<{ id: string }[]>`
      select id from public.waiver_dock_lookups limit 1`;
    expect(
      await refusal(
        asApp(
          world,
          A.id,
          (tx) => tx`update public.waiver_dock_lookups set matched = matched
                                       where id = ${row?.id ?? randomUUID()}`,
        ),
      ),
    ).not.toBe("no-error");
    // A dock start by staff, or without a lookup, is refused.
    expect(
      await refusal(
        asApp(
          world,
          B.id,
          (tx) => tx`insert into public.waiver_assisted_links
                       (access_link_id, request_id, booking_id, participant_id, mode, identity_checked)
                     select gen_random_uuid(), r.id, r.booking_id, r.participant_id, 'dock_lookup', true
                       from public.waiver_requests r where r.booking_id = ${booked.bookingId}`,
        ),
      ),
    ).toBe("23514:waiver_assisted_links_actor");
  });

  it("a lapsed lookup starts nothing", async () => {
    const { booked } = await todaysBooking("Lapsed");
    const found = await lookUp(A.id, booked.reference, "Booker");
    if (found.kind !== "matched") throw new Error(found.kind);
    await world.admin.begin(async (tx) => {
      await tx`alter table public.waiver_dock_lookups disable trigger waiver_dock_lookups_cleanup_only`;
      await tx`update public.waiver_dock_lookups set expires_at = now() - interval '1 second'
                where booking_id = ${booked.bookingId} and matched`;
      await tx`alter table public.waiver_dock_lookups enable trigger waiver_dock_lookups_cleanup_only`;
    });
    expect(await startSigning(A.id, found.secret, 1)).toEqual({ kind: "lookup_ended" });
  });

  it("after 30 days removes tries that started no signing, and redacts the client of one that did (0050)", async () => {
    const { booked } = await todaysBooking("Retain");
    const missIp = "198.51.100.77";
    expect((await lookUp(A.id, booked.reference, "Nobody", missIp)).kind).toBe("not_found");
    const unused = await lookUp(A.id, booked.reference, "Booker");
    const used = await lookUp(A.id, booked.reference, "Booker");
    if (unused.kind !== "matched" || used.kind !== "matched") throw new Error("no match");
    expect((await startSigning(A.id, used.secret, 1)).kind).toBe("issued");
    const rows = () =>
      world.admin<{ matched: boolean; client_key: string; signed: boolean }[]>`
        select k.matched, k.client_key,
               exists (select 1 from public.waiver_assisted_links a
                        where a.tenant_id = k.tenant_id and a.dock_lookup_id = k.id) as signed
          from public.waiver_dock_lookups k
         where k.tenant_id = ${A.id} and k.reference_key = ${booked.reference}
         order by k.matched, signed`;
    expect(await rows()).toHaveLength(3);

    // Under 30 days old, the cleanup leaves them all.
    await world.app`select * from app.waiver_dock_cleanup(5000)`;
    expect(await rows()).toHaveLength(3);

    // Nobody else changes or removes one, old or new.
    for (const statement of [
      (tx: Sql) => tx`update public.waiver_dock_lookups set client_key = 'redacted'
                       where reference_key = ${booked.reference}`,
      (tx: Sql) =>
        tx`delete from public.waiver_dock_lookups where reference_key = ${booked.reference}`,
    ]) {
      expect(await refusal(asApp(world, A.id, statement))).toMatch(/^(42501|55000)/);
    }
    expect(
      await refusal(
        world.admin`delete from public.waiver_dock_lookups where reference_key = ${booked.reference}`,
      ),
    ).toMatch(/^55000/);

    // A month on.
    await world.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update public.waiver_dock_lookups set created_at = now() - interval '31 days'
                where tenant_id = ${A.id} and reference_key = ${booked.reference}`;
    });
    // Even the owner, outside the cleanup, cannot.
    expect(
      await refusal(
        world.admin`delete from public.waiver_dock_lookups where reference_key = ${booked.reference}`,
      ),
    ).toMatch(/^55000/);
    const [done] = await world.app<{ deleted: number; redacted: number }[]>`
      select deleted, redacted from app.waiver_dock_cleanup(5000)`;
    expect(done?.deleted).toBeGreaterThanOrEqual(2);
    expect(done?.redacted).toBeGreaterThanOrEqual(1);
    expect(await rows()).toEqual([{ matched: true, client_key: "redacted", signed: true }]);
    // Run again: nothing more to do for these.
    await world.app`select * from app.waiver_dock_cleanup(5000)`;
    expect(await rows()).toEqual([{ matched: true, client_key: "redacted", signed: true }]);
  });
});
