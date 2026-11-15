/**
 * W3-OPS-4: waiver evidence's personal fields sealed by the application
 * (migration 0054, packages/database/src/field-crypto.ts).
 *
 * - With a keyring, the names, typed signature, address, client address, and
 *   device go into one sealed value; the plain columns stay null and no
 *   personal text is in the row. An email link's row names its link's email.
 * - The signer's view, the staff and booker listings, and a retried signature
 *   read the sealed row with the keyring, and refuse to without it.
 * - Rows written plain still read, with or without a keyring.
 * - The database holds every row to one shape.
 */
import { randomUUID } from "node:crypto";
import {
  FieldDecryptError,
  inTenantTransaction,
  newFieldKeyringSecret,
  parseFieldKeyring,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import type { BookingHooks } from "@tidegrid/domain-booking";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  getSigningView,
  listBookingWaivers,
  listGuestBookingWaivers,
  openEvidenceFields,
  type WaiverDeps,
  WaiverEvidenceSealedError,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
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
  refusal,
  sign,
  trips,
  uniqueEmail,
  type World,
} from "./harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("W3-OPS-4: sealed waiver evidence", () => {
  let world: World;
  let A: WaiverFixture;
  let nextTrip: () => string;
  let hooks: BookingHooks;
  let plain: WaiverDeps;
  let sealed: WaiverDeps;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 6);
    plain = fixtureDeps();
    sealed = { ...plain, fields: await parseFieldKeyring(newFieldKeyringSecret()) };
    hooks = fixtureHooks();
    A = await createWaiverFixture(world.admin, world.db, "wvz", { days: 6 });
    nextTrip = trips(A);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  const inA = <T>(fn: Parameters<typeof inTenantTransaction<T>>[2]) =>
    inTenantTransaction(world.db, guestCtx(A.id), fn);

  it("seals every personal field into one value, names the link's email, and reads it back only with the keyring", async () => {
    const booked = await book(world, A, nextTrip(), 2, hooks);
    const guardian = { name: "Greta Guardianson", email: uniqueEmail("greta") };
    const ann = await name(world, A.id, booked.bookingId, 1, adult("Annika Sealworth"), hooks);
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
    const sAnn = await openFor(world, A.id, rAnn);
    const sKid = await openFor(world, A.id, rKid);
    expect((await sign(world, A.id, sealed, sAnn.session)).kind).toBe("signed");
    expect((await sign(world, A.id, sealed, sKid.session, { relationship: "parent" })).kind).toBe(
      "signed",
    );

    const rows = await world.admin<
      {
        id: string;
        request_id: string;
        participant_name: string | null;
        signer_name: string | null;
        signature_text: string | null;
        recipient_email: string | null;
        source_ip: string | null;
        user_agent: string | null;
        personal_sealed: string;
        link_message_id: string;
        link_message: string;
        whole: string;
      }[]
    >`select e.id, e.request_id, e.participant_name, e.signer_name, e.signature_text,
             e.recipient_email, e.source_ip, e.user_agent, e.personal_sealed,
             e.link_message_id, l.message_id as link_message, row_to_json(e)::text as whole
        from public.waiver_evidence e
        join public.waiver_signing_sessions s on s.tenant_id = e.tenant_id and s.id = e.session_id
        join public.guest_access_links l on l.tenant_id = s.tenant_id and l.id = s.access_link_id
       where e.booking_id = ${booked.bookingId} order by e.signed_at`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([
        row.participant_name,
        row.signer_name,
        row.signature_text,
        row.recipient_email,
        row.source_ip,
        row.user_agent,
      ]).toEqual([null, null, null, null, null, null]);
      expect(row.personal_sealed).toMatch(/^tgf1:k1:/);
      expect(row.link_message_id).toBe(row.link_message);
      for (const text of [
        "Sealworth",
        "Guardianson",
        "greta",
        "198.51.100.7",
        "waiver-adversary",
      ]) {
        expect(row.whole.toLowerCase()).not.toContain(text.toLowerCase());
      }
    }
    const kidRow = rows.find((r) => r.request_id === rKid);
    if (!kidRow) throw new Error("no guardian evidence");
    expect(
      await openEvidenceFields(sealed.fields, A.id, kidRow.id, kidRow.personal_sealed),
    ).toEqual({
      participantName: "Kai Sealworth",
      signerName: "Greta Guardianson",
      signatureText: "Greta Guardianson",
      recipientEmail: guardian.email,
      sourceIp: "198.51.100.7",
      userAgent: "waiver-adversary",
    });
    // Another tenant's place does not open it.
    await expect(
      openEvidenceFields(sealed.fields, randomUUID(), kidRow.id, kidRow.personal_sealed),
    ).rejects.toBeInstanceOf(FieldDecryptError);

    // The signer's own view, and a second submission, read it with the keyring.
    const view = await inA((trx) => getSigningView(trx, A.id, sealed, sKid.session));
    expect(view.signed?.signerName).toBe("Greta Guardianson");
    expect((await sign(world, A.id, sealed, sKid.session, { relationship: "parent" })).kind).toBe(
      "already_signed",
    );
    // Staff and booker listings.
    const staff = await inA((trx) =>
      listBookingWaivers(trx, A.id, booked.bookingId, sealed.fields),
    );
    const signers = staff?.participants.map((p) => p.request?.signed?.signerName).sort();
    expect(signers).toEqual(["Annika Sealworth", "Greta Guardianson"]);
    expect(
      (await inA((trx) => listGuestBookingWaivers(trx, A.id, booked.bookingId, sealed.fields)))
        ?.participants.length,
    ).toBe(2);

    // Without the keyring, a sealed row is never read as blank.
    for (const read of [
      () => inA((trx) => getSigningView(trx, A.id, plain, sKid.session)),
      () => inA((trx) => listBookingWaivers(trx, A.id, booked.bookingId)),
    ]) {
      await expect(read()).rejects.toBeInstanceOf(WaiverEvidenceSealedError);
    }
  }, 120_000);

  it("still reads plain rows, with or without a keyring", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Pia Plain"), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const { session } = await openFor(world, A.id, req);
    expect((await sign(world, A.id, plain, session)).kind).toBe("signed");
    const [row] = await world.admin<{ signer_name: string; personal_sealed: string | null }[]>`
      select signer_name, personal_sealed from public.waiver_evidence where request_id = ${req}`;
    expect(row).toEqual({ signer_name: "Pia Plain", personal_sealed: null });
    for (const deps of [plain, sealed]) {
      const view = await inA((trx) => getSigningView(trx, A.id, deps, session));
      expect(view.signed?.signerName).toBe("Pia Plain");
    }
  }, 120_000);

  it("holds each row to one shape", async () => {
    const booked = await book(world, A, nextTrip(), 1, hooks);
    const pid = await name(world, A.id, booked.bookingId, 1, adult("Sid Shape"), hooks);
    const req = (await liveRequest(world.admin, booked.bookingId, pid)).id;
    const { session } = await openFor(world, A.id, req);
    expect((await sign(world, A.id, sealed, session)).kind).toBe("signed");
    // A copy of the sealed row with new ids, triggers and foreign keys off,
    // rolled back, so only the table's checks decide.
    const attempt = (set: string) =>
      refusal(
        world.admin.begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          await tx.unsafe(
            `insert into public.waiver_evidence
               select (r).* from (
                 select jsonb_populate_record(e, jsonb_build_object(
                          'id', '${randomUUID()}', 'request_id', '${randomUUID()}') || ${set}) as r
                   from public.waiver_evidence e where e.request_id = '${req}') s`,
          );
          throw new Error("rolled back");
        }),
      );
    expect(await attempt("'{}'::jsonb")).toBe("no-code");
    for (const field of [
      "signer_name",
      "participant_name",
      "signature_text",
      "recipient_email",
      "user_agent",
      "source_ip",
    ]) {
      expect(await attempt(`jsonb_build_object('${field}', 'x')`)).toContain("waiver_evidence");
    }
    // No sealed value and no plain fields: refused (by the method shape or the place check).
    expect(await attempt(`jsonb_build_object('personal_sealed', null)`)).toMatch(
      /waiver_evidence_(personal_place|method_shape)/,
    );
    // Plain fields beside a sealed value.
    expect(
      await attempt(
        `jsonb_build_object('signer_name', 'Sid Shape', 'participant_name', 'Sid Shape', 'signature_text', 'Sid Shape')`,
      ),
    ).toContain("waiver_evidence_personal_place");
    expect(await attempt(`jsonb_build_object('personal_sealed', 'Sid Shape')`)).toContain(
      "waiver_evidence",
    );
    expect(await attempt(`jsonb_build_object('link_message_id', null)`)).toContain(
      "waiver_evidence_method_shape",
    );
  }, 120_000);
});
