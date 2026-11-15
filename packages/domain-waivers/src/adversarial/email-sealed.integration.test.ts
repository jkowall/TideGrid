/**
 * W3-OPS-4, phases 2 and 3 (0056, 0057): waivers where every guest contact
 * detail is sealed. The database handle carries the field keyring, so party
 * members, their waiver emails, and the deliveries' addresses are stored
 * sealed or as address keys, never plain.
 *
 * - A waiver email goes to the opened address; its delivery records the key.
 * - The sending limits still hold one mailbox, compared by key.
 * - Staff see the address masked, from the opened participant.
 * - Sealed evidence records the address itself, opened from the email.
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
import {
  listBookingWaivers,
  openEvidenceFields,
  sendWaiverRequest,
  type WaiverDeps,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  deliverMail,
  fixtureDeps,
  fixtureHooks,
  minor,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  book,
  closeWorld,
  guestCtx,
  liveRequest,
  name,
  openFor,
  openWorld,
  sign,
  trips,
  uniqueEmail,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W3-OPS-4: waivers with sealed contact details", () => {
  let world: World;
  let A: WaiverFixture;
  let nextTrip: () => string;
  let hooks: BookingHooks;
  let deps: WaiverDeps;
  let keyring: FieldKeyring;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 6);
    keyring = await parseFieldKeyring(newFieldKeyringSecret());
    bindFieldPolicy(world.db, { keyring: async () => keyring, required: true });
    deps = { ...fixtureDeps(), fields: keyring };
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvc", { days: 6 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  const inA = <T>(fn: Parameters<typeof inTenantTransaction<T>>[2]) =>
    inTenantTransaction(world.db, guestCtx(A.id), fn);

  it("emails the opened address, keys the delivery, limits by key, and records the address in evidence", async () => {
    const booked = await book(world, A, nextTrip(), 2, hooks);
    const annEmail = uniqueEmail("annika");
    const guardian = { name: "Greta Guardianson", email: uniqueEmail("greta") };
    const ann = await name(
      world,
      A.id,
      booked.bookingId,
      1,
      adult("Annika Sealworth", annEmail),
      hooks,
    );
    const kid = await name(
      world,
      A.id,
      booked.bookingId,
      2,
      minor("Kai Sealworth", guardian),
      hooks,
    );
    const rAnn = (await liveRequest(world.admin, booked.bookingId, ann)).id;
    const rKid = (await liveRequest(world.admin, booked.bookingId, kid)).id;

    // Nothing plain about the guests is stored by waivers or the outbox.
    const stored = await world.admin<
      { recipient_email: string; to_email: string; whole: string }[]
    >`
      select d.recipient_email, m.to_email, row_to_json(m)::text || row_to_json(d)::text as whole
        from public.waiver_deliveries d
        join public.email_messages m on m.tenant_id = d.tenant_id and m.id = d.message_id
        join public.waiver_requests r on r.tenant_id = d.tenant_id and r.id = d.request_id
       where r.booking_id = ${booked.bookingId}`;
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.recipient_email).toMatch(/^[0-9a-f]{64}@sealed\.invalid$/);
      expect(row.to_email).toBe(row.recipient_email);
      for (const text of ["Sealworth", "Guardianson", "annika", "greta"]) {
        expect(row.whole.toLowerCase()).not.toContain(text.toLowerCase());
      }
    }

    // The link arrives at the address itself.
    const sKid = await openFor(world, A.id, rKid);
    const sAnn = await openFor(world, A.id, rAnn);

    // Staff see the address masked, and the waiver waiting on it.
    const staff = await inA((trx) => listBookingWaivers(trx, A.id, booked.bookingId, keyring));
    const kidView = staff?.participants.find((p) => p.participantId === kid);
    expect(kidView?.status).toBe("waiting");
    expect(kidView?.request?.delivery?.recipient).toBe(`g•••@${guardian.email.split("@")[1]}`);
    expect(kidView?.request?.sharedAddress).toBe(false);

    // A resend at once is held by the one-mailbox interval, compared by key.
    const again = await inA((trx) =>
      sendWaiverRequest(trx, guestCtx(A.id), deps, {
        requestId: rKid,
        kind: "resend",
        reason: "lost it",
      }),
    );
    expect(again.kind).toBe("too_soon");

    // Sealed evidence records the address the link went to, opened.
    expect((await sign(world, A.id, deps, sKid.session, { relationship: "parent" })).kind).toBe(
      "signed",
    );
    expect((await sign(world, A.id, deps, sAnn.session)).kind).toBe("signed");
    const [evidence] = await world.admin<{ id: string; personal_sealed: string }[]>`
      select id, personal_sealed from public.waiver_evidence where request_id = ${rKid}`;
    if (!evidence) throw new Error("no evidence");
    expect(
      (await openEvidenceFields(keyring, A.id, evidence.id, evidence.personal_sealed))
        .recipientEmail,
    ).toBe(guardian.email);
    // Send what is due with the keyring, so nothing sealed waits for another
    // suite's sweep, which runs without it.
    await deliverMail(world.db, A.id);
  }, 120_000);
});
