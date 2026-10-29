/**
 * G2.15 adversarial: the sending limits across a participant's requests and
 * across the operator (app.waiver_send_refusal), from the review of
 * 2026-10-20. Before them, a booker could have waiver email sent to any
 * address within seconds: corrected addresses went at once, and flipping a
 * participant between adult and minor started a new request at generation 1.
 *
 * - Alternating addresses: one email per 10 minutes to an address; a send held
 *   by the interval is queued for when it is allowed.
 * - Flipping adult and minor: the same, across new requests.
 * - Caps: 8 sends a day per participant and 10 an hour per address, after
 *   which the waiver reads email_held and nothing more is queued.
 * - The database refuses a direct insert past the limits, for tidegrid_app.
 * - An address removed and added back gets a send when the interval allows,
 *   and the status says when.
 * - The longest names a booking can hold still make a valid email.
 */
import { inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { listBookingWaivers, listGuestBookingWaivers } from "../index.ts";
import {
  adult,
  createWaiverFixture,
  deliverMail,
  fixtureHooks,
  linkFor,
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
  systemCtx,
  trips,
  uniqueEmail,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("G2.15 adversarial: sending limits across requests", () => {
  let world: World;
  let A: WaiverFixture;
  let nextTrip: () => string;
  let hooks: BookingHooks;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 12);
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvl", { days: 10 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  /** The database clock in milliseconds, which the sending limits run on. */
  async function dbNow(): Promise<number> {
    const [row] = await world.admin<{ ms: number }[]>`
      select (extract(epoch from now()) * 1000)::float8 as ms`;
    if (!row) throw new Error("no database time");
    return row.ms;
  }

  /** Every waiver email of one booking, oldest first. */
  async function emails(bookingId: string) {
    return world.admin<
      { to: string; state: string; held: boolean; request_id: string; generation: number }[]
    >`
      select m.to_email as to, m.state, d.send_after > now() + interval '1 minute' as held,
             d.request_id, d.generation
        from public.waiver_deliveries d
        join public.waiver_requests r on r.tenant_id = d.tenant_id and r.id = d.request_id
        join public.email_messages m on m.tenant_id = d.tenant_id and m.id = d.message_id
       where r.booking_id = ${bookingId}
       order by d.created_at, d.generation`;
  }

  async function statusOf(bookingId: string, position = 1) {
    const found = await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
      listBookingWaivers(trx, A.id, bookingId),
    );
    const p = found?.participants.find((x) => x.position === position);
    if (!p) throw new Error("no participant status");
    return p;
  }

  it("sends one email in 10 minutes to an address however often the guest alternates it", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const victim = uniqueEmail("val.victim");
    const other = uniqueEmail("val.other");
    const details = (email: string) => adult("Val Victim", email);
    await name(world, A.id, booked.bookingId, 1, details(victim), hooks);
    await deliverMail(world.db, A.id);
    for (const email of [other, victim, other, victim]) {
      await name(world, A.id, booked.bookingId, 1, details(email), hooks);
      await deliverMail(world.db, A.id);
    }
    const all = await emails(booked.bookingId);
    const toVictim = all.filter((e) => e.to === victim);
    expect(toVictim.filter((e) => e.state === "sent")).toHaveLength(1);
    // Every later email to the victim was held for the interval, then
    // canceled by the next change, or is still waiting for its time.
    for (const later of toVictim.slice(1)) {
      expect(later.held).toBe(true);
      expect(later.state === "canceled" || later.state === "queued").toBe(true);
    }
    expect(
      (await statusOf(booked.bookingId)).request?.delivery?.sendAfter.getTime(),
    ).toBeGreaterThan((await dbNow()) + 8 * 60_000);
  }, 240_000);

  it("holds flips between adult and minor to one email in 10 minutes, across new requests", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const victim = uniqueEmail("fay.victim");
    const asAdult = adult("Fay Flip", victim);
    const asMinor = minor("Fay Flip", { name: "Gil Guardian", email: victim });
    await name(world, A.id, booked.bookingId, 1, asAdult, hooks);
    await deliverMail(world.db, A.id);
    for (const details of [asMinor, asAdult, asMinor, asAdult, asMinor]) {
      await name(world, A.id, booked.bookingId, 1, details, hooks);
      await deliverMail(world.db, A.id);
    }
    const all = await emails(booked.bookingId);
    expect(new Set(all.map((e) => e.request_id)).size).toBe(6);
    expect(all.filter((e) => e.to === victim && e.state === "sent")).toHaveLength(1);
    expect(all.filter((e) => e.state === "queued")).toHaveLength(1);
  }, 240_000);

  it("caps one participant at eight sends a day across requests, then holds the email", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const flips = Array.from({ length: 9 }, (_, i) => {
      const email = uniqueEmail(`cap.${i}`);
      return i % 2 === 0
        ? adult("Cy Capped", email)
        : minor("Cy Capped", { name: "Cora Capped", email });
    });
    for (const details of flips) {
      await name(world, A.id, booked.bookingId, 1, details, hooks);
      await deliverMail(world.db, A.id);
    }
    const all = await emails(booked.bookingId);
    expect(all.filter((e) => e.state === "sent")).toHaveLength(8);
    const held = await statusOf(booked.bookingId);
    expect(held.status).toBe("email_held");
    expect(held.request?.resendAvailableAt?.getTime()).toBeGreaterThan(
      (await dbNow()) + 23 * 3_600_000,
    );
  }, 300_000);

  it("caps one address at ten an hour across the operator's bookings", async () => {
    const victim = uniqueEmail("ada.address");
    const first = await book(world, A, nextTrip(), 6, hooks);
    const second = await book(world, A, nextTrip(), 5, hooks);
    for (const [booking, places] of [
      [first, 6],
      [second, 5],
    ] as const) {
      for (let position = 1; position <= places; position++) {
        await name(
          world,
          A.id,
          booking.bookingId,
          position,
          adult(`Ada Guest ${"ABCDEFGHIJK"[position - 1]}`, victim),
          hooks,
        );
      }
    }
    const queued = [...(await emails(first.bookingId)), ...(await emails(second.bookingId))];
    expect(queued).toHaveLength(10);
    expect((await statusOf(second.bookingId, 5)).status).toBe("email_held");
    // The database holds the cap for a writer that skips the service.
    const eleventh = await liveRequest(
      world.admin,
      second.bookingId,
      (await statusOf(second.bookingId, 5)).participantId,
    );
    expect(
      await refusal(
        asApp(
          world,
          A.id,
          (tx) => tx`
          insert into public.waiver_deliveries (request_id, generation, kind, recipient_email,
                                                message_id)
          values (${eleventh.id}, 1, 'initial', ${victim}, gen_random_uuid())`,
        ),
      ),
    ).toBe("23514:waiver_deliveries_limit");
  }, 300_000);

  it("refuses a direct insert inside the interval, across requests, for tidegrid_app", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const victim = uniqueEmail("ira.interval");
    await name(world, A.id, booked.bookingId, 1, adult("Ira Interval", victim), hooks);
    await deliverMail(world.db, A.id);
    // A new request (now a minor), whose email the service held.
    const pid = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      minor("Ira Interval", { name: "Ivo Guardian", email: victim }),
      hooks,
    );
    const live = await liveRequest(world.admin, booked.bookingId, pid);
    expect(
      await refusal(
        asApp(
          world,
          A.id,
          (tx) => tx`
          insert into public.waiver_deliveries (request_id, generation, kind, recipient_email,
                                                message_id, reason)
          values (${live.id}, 2, 'resend', ${victim}, gen_random_uuid(), 'direct')`,
        ),
      ),
    ).toBe("23514:waiver_deliveries_rate");
  }, 240_000);

  it("sends to an address removed and added back once the interval allows, and says when", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const ren = uniqueEmail("ren.readd");
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Ren Readd", ren), hooks);
    const request = await liveRequest(world.admin, booked.bookingId, pid);
    const first = await linkFor(world.admin, world.db, A.id, request.id);
    await name(world, A.id, booked.bookingId, 1, adult("Ren Readd", null), hooks);
    expect((await statusOf(booked.bookingId)).status).toBe("no_address");
    await name(world, A.id, booked.bookingId, 1, adult("Ren Readd", ren), hooks);
    const waiting = await statusOf(booked.bookingId);
    expect(waiting.status).toBe("waiting");
    expect(waiting.request?.delivery?.generation).toBe(2);
    const waitingAt = await dbNow();
    expect(waiting.request?.delivery?.sendAfter.getTime()).toBeGreaterThan(waitingAt + 8 * 60_000);
    const guest = await inTenantTransaction(world.db, systemCtx(A.id), (trx) =>
      listGuestBookingWaivers(trx, A.id, booked.bookingId),
    );
    expect(guest?.participants[0]?.sendsAt?.getTime()).toBeGreaterThan(waitingAt + 8 * 60_000);
    // The old link stays closed; once the time comes, the new email's opens.
    expect((await redeem(world, A.id, first.token)).kind).toBe("replaced");
    await world.admin`update public.email_messages m set next_attempt_at = now()
                        from public.waiver_deliveries d
                       where d.request_id = ${request.id} and d.generation = 2
                         and m.id = d.message_id and m.state = 'queued'`;
    const second = await linkFor(world.admin, world.db, A.id, request.id);
    expect(second.to).toBe(ren);
    expect((await redeem(world, A.id, second.token)).kind).toBe("opened");
  }, 240_000);

  it("queues a valid email for a minor with the longest names a booking can hold", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const longest = (word: string) => `${word} `.repeat(30).slice(0, 120).trimEnd();
    await world.admin`
      update public.products p set name = ${longest("Expedition")}
        from public.bookings b join public.orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
       where b.id = ${booked.bookingId} and p.tenant_id = o.tenant_id and p.id = o.product_id`;
    const pid = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      minor(longest("Alexandria"), { name: longest("Maximilian"), email: uniqueEmail("max") }),
      hooks,
    );
    const request = await liveRequest(world.admin, booked.bookingId, pid);
    const [message] = await world.admin<{ subject: string }[]>`
      select m.subject from public.waiver_deliveries d
        join public.email_messages m on m.tenant_id = d.tenant_id and m.id = d.message_id
       where d.request_id = ${request.id}`;
    expect([...(message?.subject ?? "")].length).toBeLessThanOrEqual(200);
    expect(message?.subject).toContain("…");
    const sent = await linkFor(world.admin, world.db, A.id, request.id);
    expect(sent.subject).toBe(message?.subject);
  }, 240_000);
});
