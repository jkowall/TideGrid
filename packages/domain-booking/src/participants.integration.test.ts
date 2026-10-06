import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FAKE_MINIMUM_AMOUNT, type FakePaymentProvider } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  BookingHookRefusal,
  type BookingHooks,
  createCheckoutSession,
  ensureProviderPayment,
  handleVerifiedEvent,
  listParticipants,
  type ParticipantDetails,
  processProviderEvent,
  putParticipant,
} from "./index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return {
      ...(e.code ? { code: e.code } : {}),
      ...(e.constraint_name ? { constraint: e.constraint_name } : {}),
    };
  }
  throw new Error("expected a database error");
}

const adult = (name: string, email: string | null = null): ParticipantDetails => ({
  name,
  isMinor: false,
  email,
});

describe.skipIf(!env)("booking participants and lifecycle hooks against a real database", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let provider: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;

  const asGuest = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = guestContext(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };

  /** A confirmed booking on a fresh shared trip, through the real checkout and webhook path. */
  async function book(
    tenant: CheckoutFixture,
    party: number,
    hooks?: BookingHooks,
  ): Promise<{ bookingId: string; sessionId: string; paymentRef: string; outcome: string }> {
    const tripId = tripAllocatorFor(tenant).shared();
    const quote = await quoteFor(runtime.db, tenant.id, tripId, party);
    const created = await asGuest(tenant.id, (trx, ctx) =>
      createCheckoutSession(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker: { name: "Party Booker", email: "party@example.test" },
        secret: newSecret(),
        clientAddress: null,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (created.kind !== "created") throw new Error(`checkout: ${JSON.stringify(created)}`);
    const ready = await ensureProviderPayment(
      runtime.db,
      provider,
      guestContext(tenant.id),
      created.session.id,
    );
    if (ready.kind !== "ready") throw new Error(`payment: ${JSON.stringify(ready)}`);
    const settled = await provider.settlePayment(
      tenant.id,
      ready.paymentRef,
      "succeeded",
      Date.now(),
    );
    if (settled.kind === "not_found") throw new Error("no fake payment");
    const event = await verifiedFakeEvent(provider, settled.event.body);
    const handled = await handleVerifiedEvent(runtime.db, provider, event, {
      requestId: `wh-${randomUUID()}`,
      hooks,
    });
    const [row] = await admin<{ id: string }[]>`
      select id from public.bookings where checkout_session_id = ${created.session.id}`;
    return {
      bookingId: row?.id ?? "",
      sessionId: created.session.id,
      paymentRef: ready.paymentRef,
      outcome: handled.kind === "processed" ? handled.outcome : handled.kind,
    };
  }

  const allocators = new Map<string, ReturnType<typeof tripAllocator>>();
  function tripAllocatorFor(tenant: CheckoutFixture) {
    let alloc = allocators.get(tenant.id);
    if (!alloc) {
      alloc = tenant.id === A.id ? tripsA : tripAllocator(tenant);
      allocators.set(tenant.id, alloc);
    }
    return alloc;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    provider = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "ppl-a");
    B = await createCheckoutFixture(admin, runtime.db, "ppl-b");
    tripsA = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("names the party place by place, idempotently, and corrects a place in place", async () => {
    const { bookingId } = await book(A, 3);
    expect(await asGuest(A.id, (trx) => listParticipants(trx, A.id, bookingId))).toEqual({
      partySize: 3,
      participants: [],
    });

    const first = await asGuest(A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId,
        position: 1,
        details: adult("  Ada Lovelace ", "ADA@Example.TEST"),
      }),
    );
    expect(first).toMatchObject({
      kind: "created",
      participant: {
        position: 1,
        name: "Ada Lovelace",
        isMinor: false,
        email: "ada@example.test",
        guardian: null,
      },
    });

    const again = await asGuest(A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId,
        position: 1,
        details: adult("Ada Lovelace", "ada@example.test"),
      }),
    );
    expect(again.kind).toBe("unchanged");

    const minor = await asGuest(A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId,
        position: 3,
        details: {
          name: "Byron Junior",
          isMinor: true,
          guardian: { name: "Ada Lovelace", email: "Ada@Example.test" },
        },
      }),
    );
    expect(minor).toMatchObject({
      kind: "created",
      participant: {
        position: 3,
        isMinor: true,
        email: null,
        guardian: { name: "Ada Lovelace", email: "ada@example.test" },
      },
    });

    const corrected = await asGuest(A.id, (trx, ctx) =>
      putParticipant(trx, ctx, {
        bookingId,
        position: 1,
        details: adult("Ada King", null),
      }),
    );
    expect(corrected).toMatchObject({
      kind: "updated",
      changed: ["name", "email"],
      participant: { position: 1, name: "Ada King", email: null },
    });
    if (first.kind !== "created" || corrected.kind !== "updated") throw new Error("unreachable");
    expect(corrected.participant.id).toBe(first.participant.id);

    const listed = await asGuest(A.id, (trx) => listParticipants(trx, A.id, bookingId));
    expect(listed?.participants.map((p) => [p.position, p.name])).toEqual([
      [1, "Ada King"],
      [3, "Byron Junior"],
    ]);

    // Audit and events say which place and which fields, never the values.
    const audits = await admin<{ action: string; before: unknown; after: unknown }[]>`
      select action, before_state as before, after_state as after from public.audit_events
       where tenant_id = ${A.id} and subject_type = 'booking_participant' order by id`;
    expect(audits.map((a) => a.action)).toEqual([
      "participant.added",
      "participant.added",
      "participant.updated",
    ]);
    const text = JSON.stringify(audits);
    for (const value of ["Ada", "Lovelace", "Byron", "example.test"]) {
      expect(text).not.toContain(value);
    }
    const events = await admin<{ topic: string; payload: unknown }[]>`
      select topic, payload from public.outbox_events
       where tenant_id = ${A.id} and topic like 'booking.participant.%' order by id`;
    expect(events.map((e) => e.topic)).toEqual([
      "booking.participant.added",
      "booking.participant.added",
      "booking.participant.updated",
    ]);
    expect(JSON.stringify(events)).not.toContain("Ada");
  });

  it("refuses a place past the party size, in the service and in the database", async () => {
    const { bookingId } = await book(A, 2);
    expect(
      await asGuest(A.id, (trx, ctx) =>
        putParticipant(trx, ctx, { bookingId, position: 3, details: adult("Too Many") }),
      ),
    ).toEqual({ kind: "position_out_of_range", partySize: 2 });
    for (const sql of [admin, null]) {
      const attempt = sql
        ? sql`insert into public.booking_participants (tenant_id, booking_id, position, full_name, is_minor)
                values (${A.id}, ${bookingId}, 3, 'Too Many', false)`
        : asGuest(A.id, (trx) =>
            trx
              .insertInto("booking_participants")
              .values({
                tenant_id: A.id,
                booking_id: bookingId,
                position: 3,
                full_name: "Too Many",
                is_minor: false,
                email: null,
                guardian_name: null,
                guardian_email: null,
              })
              .execute(),
          );
      expect(await failure(attempt)).toEqual({
        code: "23514",
        constraint: "booking_participants_party_size",
      });
    }
    // An adult with a guardian, or a minor without one, never reaches the table.
    expect(
      await failure(
        admin`insert into public.booking_participants (tenant_id, booking_id, position, full_name,
                is_minor, guardian_name, guardian_email)
              values (${A.id}, ${bookingId}, 1, 'Adult', false, 'Parent', 'p@example.test')`,
      ),
    ).toEqual({ code: "23514", constraint: "booking_participants_guardian" });
    expect(
      await failure(
        admin`insert into public.booking_participants (tenant_id, booking_id, position, full_name, is_minor)
              values (${A.id}, ${bookingId}, 1, 'Minor', true)`,
      ),
    ).toEqual({ code: "23514", constraint: "booking_participants_guardian" });
  });

  it("keeps a participant's booking and place, and never deletes one, for any role", async () => {
    const { bookingId } = await book(A, 2);
    const other = await book(A, 2);
    const put = await asGuest(A.id, (trx, ctx) =>
      putParticipant(trx, ctx, { bookingId, position: 1, details: adult("Fixed Place") }),
    );
    if (put.kind !== "created") throw new Error("expected created");
    const id = put.participant.id;
    expect(
      await failure(admin`update public.booking_participants set position = 2 where id = ${id}`),
    ).toEqual({ code: "23514", constraint: "booking_participants_immutable" });
    expect(
      await failure(
        admin`update public.booking_participants set booking_id = ${other.bookingId} where id = ${id}`,
      ),
    ).toEqual({ code: "23514", constraint: "booking_participants_immutable" });
    expect(
      (await failure(admin`delete from public.booking_participants where id = ${id}`)).code,
    ).toBe("55000");
    // The runtime holds no DELETE at all.
    expect(
      (
        await failure(
          asGuest(A.id, (trx) =>
            trx.deleteFrom("booking_participants").where("id", "=", id).execute(),
          ),
        )
      ).code,
    ).toBe("42501");
  });

  it("serializes concurrent writes to one place: one creates, the rest see it", async () => {
    const { bookingId } = await book(A, 4);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        asGuest(A.id, (trx, ctx) =>
          putParticipant(trx, ctx, {
            bookingId,
            position: 2,
            details: adult(i % 2 === 0 ? "Even Writer" : "Odd Writer"),
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.every((r) => ["created", "updated", "unchanged"].includes(r.kind))).toBe(true);
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.booking_participants
       where booking_id = ${bookingId} and position = 2`;
    expect(row?.n).toBe(1);
  });

  it("never reaches another tenant's booking", async () => {
    const { bookingId } = await book(A, 2);
    expect(await asGuest(B.id, (trx) => listParticipants(trx, B.id, bookingId))).toBeNull();
    expect(
      await asGuest(B.id, (trx, ctx) =>
        putParticipant(trx, ctx, { bookingId, position: 1, details: adult("Intruder") }),
      ),
    ).toEqual({ kind: "booking_not_found" });
    // Under B's context, a row naming A's booking fails its composite key.
    const crossed = await failure(
      asGuest(B.id, (trx) =>
        trx
          .insertInto("booking_participants")
          .values({
            tenant_id: B.id,
            booking_id: bookingId,
            position: 1,
            full_name: "Intruder",
            is_minor: false,
            email: null,
            guardian_name: null,
            guardian_email: null,
          })
          .execute(),
      ),
    );
    expect(["23503"]).toContain(crossed.code);
    // And under A's context, a row claiming B's tenant finds no booking of B's
    // (row-level security hides B), so the trigger refuses it before the policy's check.
    expect(
      await failure(
        asGuest(A.id, (trx) =>
          trx
            .insertInto("booking_participants")
            .values({
              tenant_id: B.id,
              booking_id: bookingId,
              position: 1,
              full_name: "Intruder",
              is_minor: false,
              email: null,
              guardian_name: null,
              guardian_email: null,
            })
            .execute(),
        ),
      ),
    ).toEqual({ code: "23503", constraint: "booking_participants_booking" });
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.booking_participants where booking_id = ${bookingId}`;
    expect(row?.n).toBe(0);
  });

  it("runs the hooks inside each change, and a refusal rolls the change back", async () => {
    const calls: { hook: string; event: unknown; inTx: boolean }[] = [];
    const hooks: BookingHooks = {
      bookingConfirmed: async (trx, ctx, event) => {
        // The booking is visible inside the confirming transaction.
        const [row] = await trx
          .selectFrom("bookings")
          .select("state")
          .where("tenant_id", "=", ctx.tenantId)
          .where("id", "=", event.bookingId)
          .execute();
        calls.push({ hook: "bookingConfirmed", event, inTx: row?.state === "confirmed" });
      },
      participantAdded: async (_trx, _ctx, event) => {
        calls.push({ hook: "participantAdded", event, inTx: true });
        if (event.position === 2) {
          throw new BookingHookRefusal("waiver_refused", "This place cannot be named yet");
        }
      },
      participantUpdated: async (_trx, _ctx, event) => {
        calls.push({ hook: "participantUpdated", event, inTx: true });
      },
    };
    const booked = await book(A, 2, hooks);
    expect(booked.outcome).toBe("confirmed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      hook: "bookingConfirmed",
      inTx: true,
      event: { bookingId: booked.bookingId, partySize: 2, reacquired: false },
    });

    await asGuest(A.id, (trx, ctx) =>
      putParticipant(
        trx,
        ctx,
        {
          bookingId: booked.bookingId,
          position: 1,
          details: adult("Hooked One"),
        },
        hooks,
      ),
    );
    await asGuest(A.id, (trx, ctx) =>
      putParticipant(
        trx,
        ctx,
        {
          bookingId: booked.bookingId,
          position: 1,
          details: adult("Hooked Once"),
        },
        hooks,
      ),
    );
    expect(calls.slice(1).map((c) => c.hook)).toEqual(["participantAdded", "participantUpdated"]);
    expect(calls[2]?.event).toMatchObject({ changed: ["name"], position: 1 });

    await expect(
      asGuest(A.id, (trx, ctx) =>
        putParticipant(
          trx,
          ctx,
          {
            bookingId: booked.bookingId,
            position: 2,
            details: adult("Refused Two"),
          },
          hooks,
        ),
      ),
    ).rejects.toBeInstanceOf(BookingHookRefusal);
    const rows = await admin<{ position: number }[]>`
      select position from public.booking_participants
       where booking_id = ${booked.bookingId} order by position`;
    expect(rows.map((r) => r.position)).toEqual([1]);
    const [audit] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.outbox_events
       where tenant_id = ${A.id} and topic = 'booking.participant.added'
         and payload->>'bookingId' = ${booked.bookingId}`;
    expect(audit?.n).toBe(1);
  });

  it("rolls back a confirmation whose hook throws, leaving the event for the retry", async () => {
    const failing: BookingHooks = {
      bookingConfirmed: async () => {
        throw new Error("waiver store unavailable");
      },
    };
    await expect(book(A, 1, failing)).rejects.toThrow("waiver store unavailable");
    const [row] = await admin<{ bookings: number; received: number }[]>`
      select (select count(*)::int from public.bookings b
                join public.checkout_sessions s on s.id = b.checkout_session_id
               where s.tenant_id = ${A.id} and b.party_size = 1) as bookings,
             (select count(*)::int from public.provider_events e
               where e.tenant_id = ${A.id} and e.processing_state = 'received') as received`;
    expect(row).toEqual({ bookings: 0, received: 1 });
    // The retry, with working hooks, confirms it; nothing is left for another suite's sweep.
    const [pending] = await admin<{ id: string }[]>`
      select id from public.provider_events
       where tenant_id = ${A.id} and processing_state = 'received'`;
    if (!pending) throw new Error("no received event");
    const ctx = guestContext(A.id);
    const retried = await inTenantTransaction(runtime.db, ctx, (trx) =>
      processProviderEvent(trx, { ...ctx, actorType: "system" }, pending.id),
    );
    expect(retried?.outcome).toBe("confirmed");
  });
});
