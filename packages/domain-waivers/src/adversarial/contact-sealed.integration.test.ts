/**
 * W3-OPS-4, phase 2 (0056): waiver status where party members are sealed.
 * The database handle carries the field keyring, so the database cannot read
 * a participant's address; waiver status works out each request's current
 * address, a guardian's address shared with an adult, and when staff may send
 * again after opening the party, and must map each answer back to its own
 * participant.
 */
import {
  bindFieldPolicy,
  type FieldKeyring,
  inTenantTransaction,
  newFieldKeyringSecret,
  parseFieldKeyring,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { listBookingWaivers, listTripWaivers } from "../index.ts";
import {
  adult,
  createWaiverFixture,
  fixtureHooks,
  minor,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  book,
  closeWorld,
  guestCtx,
  name,
  openWorld,
  trips,
  uniqueEmail,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W3-OPS-4: waiver status with sealed participants", () => {
  let world: World;
  let A: WaiverFixture;
  let nextTrip: () => string;
  let hooks: BookingHooks;
  let keyring: FieldKeyring;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 6);
    keyring = await parseFieldKeyring(newFieldKeyringSecret());
    bindFieldPolicy(world.db, { keyring: async () => keyring, required: true });
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvc", { days: 6 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  const inA = <T>(fn: Parameters<typeof inTenantTransaction<T>>[2]) =>
    inTenantTransaction(world.db, guestCtx(A.id), fn);

  it("finds a shared guardian address, masks each address, and maps each send time to its participant", async () => {
    const tripId = nextTrip();
    const booked = await book(world, A, tripId, 3, hooks);
    const shared = uniqueEmail("annika");
    const ann = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("Annika Sealworth", shared),
      hooks,
    );
    const kid = await name(
      world,
      A.id,
      booked.bookingId,
      2,
      minor("Kai Sealworth", { name: "Annika Sealworth", email: shared }),
      hooks,
    );
    const ben = await name(
      world,
      A.id,
      booked.bookingId,
      3,
      adult("Ben Sealworth", uniqueEmail("ben")),
      hooks,
    );

    // Nothing plain about the party is stored.
    const [row] = await world.admin<{ whole: string }[]>`
      select json_agg(p)::text as whole from public.booking_participants p
       where p.booking_id = ${booked.bookingId}`;
    expect(row?.whole.toLowerCase()).not.toContain("sealworth");

    const before = await inA((trx) => listBookingWaivers(trx, A.id, booked.bookingId, keyring));
    const view = (id: string) => before?.participants.find((p) => p.participantId === id);
    expect(view(ann)?.status).toBe("waiting");
    expect(view(kid)?.status).toBe("waiting");
    expect(view(ben)?.status).toBe("waiting");
    // The guardian's address is an adult's own in the same party.
    expect(view(kid)?.request?.sharedAddress).toBe(true);
    expect(view(ann)?.request?.sharedAddress).toBe(false);
    expect(view(kid)?.request?.delivery?.recipient).toBe("a•••@example.test");
    expect(view(ben)?.request?.delivery?.recipient).toBe("b•••@example.test");
    // Each was just emailed, so the one-mailbox interval holds a resend.
    for (const id of [ann, kid, ben]) {
      expect(view(id)?.request?.resendAvailableAt?.getTime()).toBeGreaterThan(Date.now());
    }

    // Ben's address removed: his request has none, and only his answer changes.
    await name(world, A.id, booked.bookingId, 3, adult("Ben Sealworth", null), hooks);
    const after = await inA((trx) => listBookingWaivers(trx, A.id, booked.bookingId, keyring));
    const now = (id: string) => after?.participants.find((p) => p.participantId === id);
    expect(now(ben)?.status).toBe("no_address");
    expect(now(ben)?.request?.resendAvailableAt).toBeNull();
    expect(now(kid)?.request?.resendAvailableAt).toEqual(view(kid)?.request?.resendAvailableAt);
    expect(now(ann)?.request?.resendAvailableAt).toEqual(view(ann)?.request?.resendAvailableAt);
    expect(now(kid)?.request?.sharedAddress).toBe(true);

    // The trip's view reads the same, booking by booking.
    const trip = await inA((trx) => listTripWaivers(trx, A.id, tripId, keyring));
    const ours = trip?.bookings.find((b) => b.bookingId === booked.bookingId);
    expect(ours?.participants.map((p) => [p.participantId, p.status])).toEqual(
      after?.participants.map((p) => [p.participantId, p.status]),
    );
  }, 120_000);
});
