import { randomUUID } from "node:crypto";
import {
  bindFieldPolicy,
  createDb,
  emailToken,
  type FieldKeyring,
  FieldKeyringError,
  inTenantTransaction,
  newFieldKeyringSecret,
  parseFieldKeyring,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { deliverTenantMessages, FakeEmailProvider } from "@tidegrid/domain-messaging";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inviteParticipant, listParticipants, putParticipant } from "./index.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

/**
 * Sealed participants (W3-OPS-4, 0056, owner decision 2026-11-15): where the
 * database handle carries a field keyring, a party member's name and
 * addresses are written sealed with a blind index token per address, never
 * plain, and every reader opens them. A correction stays sealed; a row never
 * moves between plain and sealed; an invitation to a sealed participant is
 * matched to them by its address token.
 */
describe.skipIf(!env)("sealed participants (W3-OPS-4, 0056)", () => {
  let admin: Sql;
  let sealed: ReturnType<typeof createDb>;
  let plain: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let mail: FakeEmailProvider;
  let keyring: FieldKeyring;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;

  const as = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
    db = sealed.db,
  ): Promise<T> => inTenantTransaction(db, ctx, (trx) => fn(trx, ctx));
  const put = (
    bookingId: string,
    position: number,
    details: Parameters<typeof putParticipant>[2]["details"],
    db = sealed.db,
  ) =>
    as(
      guestContext(A.id),
      (trx, c) => putParticipant(trx, c, { bookingId, position, details }),
      db,
    );
  const stored = async (bookingId: string, position: number) => {
    const [row] = await admin<
      {
        id: string;
        full_name: string | null;
        email: string | null;
        guardian_name: string | null;
        guardian_email: string | null;
        contact_sealed: string | null;
        email_index: string | null;
        guardian_email_index: string | null;
      }[]
    >`select id, full_name, email, guardian_name, guardian_email, contact_sealed, email_index,
             guardian_email_index
        from public.booking_participants
       where booking_id = ${bookingId} and position = ${position}`;
    if (!row) throw new Error("no participant");
    return row;
  };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    keyring = await parseFieldKeyring(newFieldKeyringSecret());
    sealed = createDb(env.runtimeUrl, { max: 4 });
    bindFieldPolicy(sealed.db, { keyring: async () => keyring, required: true });
    plain = createDb(env.runtimeUrl, { max: 2 });
    payments = fakeProvider(sealed.db);
    mail = new FakeEmailProvider({ db: sealed.db, environment: "local" });
    A = await createCheckoutFixture(admin, sealed.db, "seal-p", { days: 6 });
    trips = tripAllocator(A);
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${`${A.slug}.book.localhost`}, ${A.id}, 'preview', 'active', now())`;
  });

  afterAll(async () => {
    await sealed?.end();
    await plain?.end();
    await admin?.end({ timeout: 5 });
  });

  it("writes a party member sealed with address tokens, and reads them back opened", async () => {
    const run = randomUUID().slice(0, 8);
    const { bookingId } = await confirmBooking(sealed.db, payments, A, trips.shared(), 2);
    const adult = await put(bookingId, 1, {
      name: "  Ana Example ",
      isMinor: false,
      email: `ANA-${run}@Example.test`,
    });
    expect(adult).toMatchObject({
      kind: "created",
      participant: { name: "Ana Example", email: `ana-${run}@example.test`, guardian: null },
    });
    await put(bookingId, 2, {
      name: "Kit Kid",
      isMinor: true,
      guardian: { name: "Gail Guardian", email: `gail-${run}@example.test` },
    });
    const a = await stored(bookingId, 1);
    expect(a).toMatchObject({ full_name: null, email: null, guardian_email_index: null });
    expect(a.contact_sealed).toMatch(/^tgf1:k1:/);
    expect(a.email_index).toMatch(/^[0-9a-f]{64}$/);
    const k = await stored(bookingId, 2);
    expect(k).toMatchObject({ full_name: null, guardian_name: null, email_index: null });
    expect(k.guardian_email_index).toMatch(/^[0-9a-f]{64}$/);
    // Nothing plain anywhere in the row.
    expect(JSON.stringify([a, k])).not.toMatch(/Ana|Kit|Gail|example\.test/);

    const party = await as(guestContext(A.id), (trx) => listParticipants(trx, A.id, bookingId));
    expect(party?.participants.map((p) => [p.name, p.email, p.guardian])).toEqual([
      ["Ana Example", `ana-${run}@example.test`, null],
      ["Kit Kid", null, { name: "Gail Guardian", email: `gail-${run}@example.test` }],
    ]);

    // A handle with no keyring cannot read the party, and never reads it as blank.
    const unread = await as(
      guestContext(A.id),
      (trx) => listParticipants(trx, A.id, bookingId),
      plain.db,
    ).catch((e: unknown) => e);
    expect(unread).toBeInstanceOf(FieldKeyringError);
  });

  it("finds the same details unchanged, and keeps a correction sealed", async () => {
    const run = randomUUID().slice(0, 8);
    const { bookingId } = await confirmBooking(sealed.db, payments, A, trips.shared(), 1);
    const email = `bo-${run}@example.test`;
    await put(bookingId, 1, { name: "Bo Typo", isMinor: false, email });
    const before = await stored(bookingId, 1);
    expect(await put(bookingId, 1, { name: "Bo Typo", isMinor: false, email })).toMatchObject({
      kind: "unchanged",
    });
    expect((await stored(bookingId, 1)).contact_sealed).toBe(before.contact_sealed);

    const fixed = await put(bookingId, 1, { name: "Bo Typo", isMinor: false, email: null });
    expect(fixed).toMatchObject({ kind: "updated", changed: ["email"] });
    const after = await stored(bookingId, 1);
    expect(after.full_name).toBeNull();
    expect(after.contact_sealed).not.toBe(before.contact_sealed);
    expect(after.email_index).toBeNull();

    // A participant written plain stays plain, even through a handle with a keyring.
    const plainBooking = await confirmBooking(plain.db, payments, A, trips.shared(), 1);
    await put(
      plainBooking.bookingId,
      1,
      { name: "Pat Plain", isMinor: false, email: null },
      plain.db,
    );
    await put(plainBooking.bookingId, 1, {
      name: "Pat Plainer",
      isMinor: false,
      email: `pat-${run}@example.test`,
    });
    expect(await stored(plainBooking.bookingId, 1)).toMatchObject({
      full_name: "Pat Plainer",
      email: `pat-${run}@example.test`,
      contact_sealed: null,
      email_index: null,
    });
  });

  it("refuses to move a row between plain and sealed, or to seal a minor with no guardian token", async () => {
    const { bookingId } = await confirmBooking(sealed.db, payments, A, trips.shared(), 1);
    await put(bookingId, 1, {
      name: "Kit Kid",
      isMinor: true,
      guardian: { name: "Gail Guardian", email: "gail@example.test" },
    });
    const row = await stored(bookingId, 1);
    const refused = (fn: (trx: TenantTransaction) => Promise<unknown>) =>
      as(guestContext(A.id), (trx) => fn(trx), plain.db).then(
        () => null,
        (e: { constraint_name?: string }) => e.constraint_name ?? String(e),
      );
    expect(
      await refused((trx) =>
        sql`update booking_participants
               set contact_sealed = null, guardian_email_index = null, full_name = 'Kit Kid',
                   guardian_name = 'Gail', guardian_email = 'gail@example.test'
             where tenant_id = ${A.id} and id = ${row.id}`.execute(trx),
      ),
    ).toBe("booking_participants_contact_place");
    expect(
      await refused((trx) =>
        sql`update booking_participants set guardian_email_index = null
             where tenant_id = ${A.id} and id = ${row.id}`.execute(trx),
      ),
    ).toBe("booking_participants_guardian");
  });

  it("invites a sealed participant at their address, matched by its token", async () => {
    const run = randomUUID().slice(0, 8);
    const { bookingId } = await confirmBooking(sealed.db, payments, A, trips.shared(), 1);
    const email = `cal-${run}@example.test`;
    await put(bookingId, 1, { name: "Cal Crew", isMinor: false, email });
    const invited = await as(guestContext(A.id), (trx, c) =>
      inviteParticipant(trx, c, { bookingId, position: 1 }),
    );
    expect(invited).toMatchObject({ kind: "invited", recipient: "participant" });
    const [msg] = await admin<{ id: string; to_email: string; to_email_index: string | null }[]>`
      select id, to_email, to_email_index from public.email_messages
       where booking_id = ${bookingId} and link_purpose = 'participant_profile'`;
    expect(msg?.to_email).toBe(email);
    expect(msg?.to_email_index).toBe((await stored(bookingId, 1)).email_index);

    await deliverTenantMessages(sealed.db, A.id, {
      provider: mail,
      fromAddress: "bookings@tidegrid.test",
      guestLinkOrigin: "http://{slug}.book.localhost:5301",
      environment: "local",
      runId: `run-${randomUUID()}`,
    });
    const [sent] = await admin<{ state: string; last_error_code: string | null }[]>`
      select state, last_error_code from public.email_messages where id = ${msg?.id ?? ""}`;
    expect(sent).toEqual({ state: "sent", last_error_code: null });
    expect((await mail.listMailbox(A.id)).some((m) => m.to === email)).toBe(true);

    // An invitation row whose token is not the participant's is refused.
    const wrong = await as(guestContext(A.id), (trx) =>
      sql`update email_messages set to_email_index = ${"0".repeat(64)}
           where tenant_id = ${A.id} and id = ${msg?.id ?? ""}`.execute(trx),
    ).catch((e: { code?: string }) => e.code);
    // No UPDATE grant on the token: it is written once, with the message.
    expect(wrong).toBe("42501");
  });

  it("refuses an invitation to a sealed minor without the guardian's token, or with another", async () => {
    const run = randomUUID().slice(0, 8);
    const { bookingId } = await confirmBooking(sealed.db, payments, A, trips.shared(), 2);
    const guardian = `gail-${run}@example.test`;
    const adult = `oli-${run}@example.test`;
    await put(bookingId, 1, {
      name: "Kit Kid",
      isMinor: true,
      guardian: { name: "Gail Guardian", email: guardian },
    });
    await put(bookingId, 2, { name: "Oli Other", isMinor: false, email: adult });
    const invited = await as(guestContext(A.id), (trx, c) =>
      inviteParticipant(trx, c, { bookingId, position: 1 }),
    );
    expect(invited).toMatchObject({ kind: "invited", recipient: "guardian" });
    const [msg] = await admin<{ id: string; to_email_index: string | null }[]>`
      select id, to_email_index from public.email_messages
       where booking_id = ${bookingId} and link_purpose = 'participant_profile'`;
    if (!msg) throw new Error("no invitation");
    expect(msg.to_email_index).toBe(await emailToken(keyring, A.id, guardian));

    // The same invitation again, written with each token: as tidegrid_app.
    const copy = (index: string | null) =>
      as(guestContext(A.id), (trx) =>
        sql`insert into email_messages (tenant_id, dedupe_key, template, template_version,
              booking_id, participant_id, to_email, to_email_index, to_name, from_name, reply_to,
              subject, html_body, text_body, link_purpose, link_path, link_ttl_seconds, link_slot)
            select tenant_id, 'participant.invitation:' || participant_id || ':' || gen_random_uuid(),
                   template, template_version, booking_id, participant_id, to_email, ${index},
                   to_name, from_name, reply_to, subject, html_body, text_body, link_purpose,
                   link_path, link_ttl_seconds, link_slot
              from email_messages where tenant_id = ${A.id} and id = ${msg.id}`.execute(trx),
      ).then(
        () => "accepted",
        (e: { constraint_name?: string }) => e.constraint_name ?? String(e),
      );
    expect(await copy(null)).toBe("email_messages_profile_recipient");
    // Another adult's address in the same party, and a stranger's.
    expect(await copy(await emailToken(keyring, A.id, adult))).toBe(
      "email_messages_profile_recipient",
    );
    expect(await copy("0".repeat(64))).toBe("email_messages_profile_recipient");
    // The guardian's token, the one the minor's invitation goes to.
    expect(await copy(await emailToken(keyring, A.id, guardian))).toBe("accepted");
  });
});
