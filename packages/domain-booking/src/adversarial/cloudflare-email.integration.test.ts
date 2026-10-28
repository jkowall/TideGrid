/**
 * Booking email over the Cloudflare email adapter (G2.16a), per message
 * kind. A message that carries an access link needs a real booking, so these
 * checks live beside the booking fixtures; delivery itself is covered in
 * packages/domain-messaging/src/cloudflare.integration.test.ts.
 *
 * Cloudflare documents no idempotency key. Under the coordinator default for
 * D1 (B, at most once for a provider that does not deduplicate), an attempt
 * whose outcome is unknown is never repeated, for every kind: the
 * confirmation and the manage-link email (which carry links) and the
 * cancellation notice (which does not). The guest recovers a lost
 * management link by asking for a new one; the rest waits for staff resend
 * (G2.16b). A copy that did go out keeps the only working link of its message.
 *
 * The binding is an inline recording stand-in with the documented shape
 * (`send(builder)` answers `{ messageId }` or throws an `Error` with a
 * `code`); the package's recorded fixture is not exported.
 */
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  type CloudflareEmailBuilder,
  createCloudflareEmailProvider,
  type EmailProvider,
  FakeEmailProvider,
  type SendEmailBinding,
} from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cancelBooking, previewCancellation, requestManageLink } from "../index.ts";
import { type CheckoutFixture, createCheckoutFixture, fakeProvider } from "../test-fixtures.ts";
import {
  addLocalHostname,
  asGuest,
  type Booked,
  book,
  deliverMail,
  messagesOf,
  redeem,
  type SelfServiceWorld,
  tokenIn,
} from "./self-service-harness.ts";

const env = inject("integrationDb");

interface Recorder {
  binding: SendEmailBinding;
  sends: CloudflareEmailBuilder[];
  failNext(code: string): void;
}

function recorder(): Recorder {
  const sends: CloudflareEmailBuilder[] = [];
  const faults: string[] = [];
  let n = 0;
  return {
    sends,
    failNext: (code) => faults.push(code),
    binding: {
      send: async (builder) => {
        sends.push(structuredClone(builder));
        const code = faults.shift();
        if (code)
          throw Object.assign(new Error(`${code} for ${JSON.stringify(builder.to)}`), { code });
        n += 1;
        return { messageId: `<cfmsg${String(n).padStart(31, "0")}@tidegrid.test>` };
      },
    },
  };
}

describe.skipIf(!env)("booking email over the Cloudflare email adapter (G2.16a)", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;
  let count = 0;
  const bookers: string[] = [];

  function booker() {
    count += 1;
    const email = `cf.booker.${count}.${Date.now().toString(36)}@example.test`;
    bookers.push(email);
    return { name: `Synthetic CF Booker ${count}`, email };
  }

  function cloudflare(rec: Recorder): EmailProvider {
    return createCloudflareEmailProvider({
      binding: rec.binding,
      recipients: { kind: "only", addresses: new Set(bookers) },
      environment: "local",
    });
  }

  const callsFor = (rec: Recorder, messageId: string) =>
    rec.sends.filter((b) => b.headers["X-TideGrid-Message-Id"] === messageId);

  async function liveLinks(messageId: string): Promise<number> {
    const [r] = await world.admin<{ n: number }[]>`
      select count(*)::int as n from public.guest_access_links
       where message_id = ${messageId} and consumed_at is null and revoked_at is null`;
    return r?.n ?? 0;
  }

  async function cancel(b: Booked) {
    const terms = await asGuest(world.db, A.id, (trx) =>
      previewCancellation(trx, A.id, b.bookingId),
    );
    if (!terms) throw new Error("setup: no terms");
    const done = await asGuest(world.db, A.id, (trx, ctx) =>
      cancelBooking(trx, ctx, { bookingId: b.bookingId, expectedRefundAmount: terms.refundAmount }),
    );
    if (done.kind !== "canceled") throw new Error(`setup cancel: ${done.kind}`);
  }

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
    A = await createCheckoutFixture(admin, runtime.db, "cf-email-a", { days: 30 });
    await addLocalHostname(admin, A);
    trips = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("sends the confirmation with its link filled into the HTML and the text", async () => {
    const rec = recorder();
    const b = await book(world, A, trips.shared(), 1, { booker: booker() });
    await deliverMail(world, A.id, cloudflare(rec));
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation");
    expect(confirmation).toMatchObject({ template: "booking_confirmation", state: "sent" });
    const [sent] = callsFor(rec, confirmation.id);
    if (!sent) throw new Error("the confirmation was not sent");
    const token = tokenIn(sent.html);
    if (!token) throw new Error("no link in the HTML");
    const url = `http://${A.slug}.book.localhost:5301/manage#t=${token}`;
    expect(sent.html).toContain(url);
    expect(sent.text).toContain(url);
    expect(`${sent.html}${sent.text}`).not.toContain("{{tidegrid-link:");
    expect((await redeem(world, A.id, token)).kind).toBe("opened");
    const [stored] = await world.admin<{ provider: string; provider_message_id: string }[]>`
      select provider, provider_message_id from public.email_messages where id = ${confirmation.id}`;
    expect(stored).toEqual({
      provider: "cloudflare",
      provider_message_id: expect.stringMatching(/^<cfmsg\d{31}@tidegrid\.test>$/),
    });
  });

  it("fails a confirmation with an unknown outcome once, and the guest recovers with a new link", async () => {
    const rec = recorder();
    const b = await book(world, A, trips.shared(), 1, { booker: booker() });
    rec.failNext("E_DELIVERY_FAILED");
    await deliverMail(world, A.id, cloudflare(rec));
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation");
    expect(confirmation).toMatchObject({ state: "failed", last_error_code: "outcome_unknown" });
    await deliverMail(world, A.id, cloudflare(rec));
    expect(callsFor(rec, confirmation.id)).toHaveLength(1);

    const asked = await asGuest(world.db, A.id, (trx, ctx) =>
      requestManageLink(trx, ctx, { bookingId: b.bookingId, requestKey: "cf-recover" }),
    );
    if (asked.kind !== "enqueued") throw new Error(`setup: ${asked.kind}`);
    await deliverMail(world, A.id, cloudflare(rec));
    const [fresh] = callsFor(rec, asked.messageId);
    const token = fresh ? tokenIn(fresh.html) : null;
    if (!token) throw new Error("no link in the new email");
    expect((await redeem(world, A.id, token)).kind).toBe("opened");
  });

  it("fails a manage-link email with an unknown outcome once", async () => {
    const rec = recorder();
    const b = await book(world, A, trips.shared(), 1, { booker: booker() });
    await deliverMail(world, A.id, cloudflare(rec));
    const asked = await asGuest(world.db, A.id, (trx, ctx) =>
      requestManageLink(trx, ctx, { bookingId: b.bookingId, requestKey: "cf-ambiguous" }),
    );
    if (asked.kind !== "enqueued") throw new Error(`setup: ${asked.kind}`);
    rec.failNext("E_INTERNAL_SERVER_ERROR");
    await deliverMail(world, A.id, cloudflare(rec));
    await deliverMail(world, A.id, cloudflare(rec));
    expect(callsFor(rec, asked.messageId)).toHaveLength(1);
    const rows = await messagesOf(world.admin, b.bookingId);
    expect(rows.find((m) => m.id === asked.messageId)).toMatchObject({
      template: "booking_manage_link",
      state: "failed",
      last_error_code: "outcome_unknown",
    });
  });

  it("sends no second copy after a lapsed lease, so the delivered link is the message's only one", async () => {
    const rec = recorder();
    const cf = cloudflare(rec);
    const b = await book(world, A, trips.shared(), 1, { booker: booker() });
    let second: Awaited<ReturnType<typeof deliverMail>> | undefined;
    const stalling: EmailProvider = {
      name: "cloudflare",
      deduplicates: false,
      send: async (email) => {
        const sent = await cf.send(email);
        if (!second) {
          await world.admin`update public.email_messages
                               set lease_expires_at = now() - interval '1 second'
                             where id = ${email.idempotencyKey}`;
          second = await deliverMail(world, A.id, cf);
        }
        return sent;
      },
    };
    await deliverMail(world, A.id, stalling);
    const [confirmation] = await messagesOf(world.admin, b.bookingId);
    if (!confirmation) throw new Error("setup: no confirmation");
    expect(second?.items.find((i) => i.messageId === confirmation.id)).toMatchObject({
      outcome: "failed",
      code: "outcome_unknown",
    });
    const copies = callsFor(rec, confirmation.id);
    expect(copies).toHaveLength(1);
    expect(await liveLinks(confirmation.id)).toBe(1);
    const token = tokenIn(copies[0]?.html ?? "");
    if (!token) throw new Error("no link in the delivered copy");
    expect((await redeem(world, A.id, token)).kind).toBe("opened");
  });

  it("fails a cancellation notice, which carries no link, with an unknown outcome once", async () => {
    const rec = recorder();
    const b = await book(world, A, trips.shared(), 1, { booker: booker() });
    await deliverMail(world, A.id, cloudflare(rec));
    await cancel(b);
    rec.failNext("E_INTERNAL_SERVER_ERROR");
    await deliverMail(world, A.id, cloudflare(rec));
    await deliverMail(world, A.id, cloudflare(rec));
    const rows = await messagesOf(world.admin, b.bookingId);
    const notice = rows.find((m) => m.template === "booking_canceled");
    if (!notice) throw new Error("setup: no cancellation notice");
    expect(notice).toMatchObject({ state: "failed", last_error_code: "outcome_unknown" });
    expect(callsFor(rec, notice.id)).toHaveLength(1);
  });
});
