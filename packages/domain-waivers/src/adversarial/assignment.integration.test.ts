/**
 * G2.15 adversarial: assignment through the booking hooks, against the
 * waiver contract (packages/domain-waivers/README.md, "Assignment through the
 * booking hooks" and "Which version applies").
 *
 * - One live request per participant and booking, and one per (booking,
 *   participant, version) among live requests, while a retried confirmation
 *   hook, participant additions, and corrections race on separate connections.
 * - No duplicate delivery generation and no second email for a generation; a
 *   retried hook creates and sends nothing.
 * - The booking-source matrix: a booking confirmed by the webhook route and one
 *   the checkout sweep confirmed from a received event assign identically.
 *   Staff-entered and imported bookings do not exist yet (a recorded gap).
 * - A participant assigned while a publish that moves unsigned work commits.
 */
import { randomUUID } from "node:crypto";
import { inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type BookingConfirmedEvent,
  type BookingHooks,
  createCheckoutSession,
  ensureProviderPayment,
  handleVerifiedEvent,
  type ParticipantDetails,
  putParticipant,
  sweepCheckouts,
} from "@tidegrid/domain-booking";
import {
  fakeProvider,
  guestContext,
  newSecret,
  quoteFor,
  verifiedFakeEvent,
} from "@tidegrid/domain-booking/testing";
import { FAKE_MINIMUM_AMOUNT } from "@tidegrid/domain-payments";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  assignBookingWaivers,
  listBookingWaivers,
  publishWaiverTemplateVersion,
  type WaiverDeps,
} from "../index.ts";
import {
  adult,
  createWaiverFixture,
  FIXTURE_TEXT,
  fixtureDeps,
  fixtureHooks,
  minor,
  nameParticipant,
  type WaiverFixture,
} from "../test-fixtures.ts";
import {
  barrier,
  book,
  closeWorld,
  gate,
  guestCtx,
  name,
  openWorld,
  settle,
  systemCtx,
  trips,
  uniqueEmail,
  type World,
  within,
} from "./harness.ts";

const env = inject("integrationDb");
const ROUNDS = 2;

describe.skipIf(!env)("G2.15 adversarial: assignment", () => {
  let world: World;
  let T: WaiverFixture;
  let nextTrip: () => string;
  let deps: WaiverDeps;
  let hooks: BookingHooks;

  beforeAll(async () => {
    if (!env) return;
    world = openWorld(env, 16);
    deps = fixtureDeps();
    hooks = fixtureHooks();
    T = await createWaiverFixture(world.admin, world.db, "wva", { days: 8 });
    nextTrip = trips(T);
  });

  afterAll(async () => {
    await closeWorld(world);
  });

  /** Every request of a booking with its deliveries and their messages, as stored. */
  async function ledger(bookingId: string) {
    const requests = await world.admin<
      {
        id: string;
        participant_id: string;
        state: string;
        required_signer: string;
        v: number;
        revoked_reason: string | null;
      }[]
    >`select id, participant_id, state, required_signer, template_version as v, revoked_reason
        from public.waiver_requests where booking_id = ${bookingId} order by created_at, id`;
    const deliveries = await world.admin<
      {
        request_id: string;
        generation: number;
        kind: string;
        recipient_email: string;
        message_id: string;
        dedupe_key: string;
        to_email: string;
        state: string;
      }[]
    >`select d.request_id, d.generation, d.kind, d.recipient_email, d.message_id,
             m.dedupe_key, m.to_email, m.state
        from public.waiver_deliveries d
        join public.email_messages m on m.tenant_id = d.tenant_id and m.id = d.message_id
        join public.waiver_requests r on r.tenant_id = d.tenant_id and r.id = d.request_id
       where r.booking_id = ${bookingId}
       order by d.request_id, d.generation`;
    const messages = await world.admin<{ subject_ref: string; dedupe_key: string; state: string }[]>`
      select subject_ref, dedupe_key, state from public.email_messages
       where booking_id = ${bookingId} and template = 'waiver_request'
       order by dedupe_key`;
    const participants = await world.admin<
      { id: string; position: number; is_minor: boolean; email: string | null; ge: string | null }[]
    >`select id, position, is_minor, email, guardian_email as ge from public.booking_participants
       where booking_id = ${bookingId} order by position`;
    return { requests, deliveries, messages, participants };
  }

  /** The contract's invariants over one booking's stored waiver state. */
  function expectConsistent(l: Awaited<ReturnType<typeof ledger>>) {
    // One live request per named participant, for the signer they need now.
    for (const p of l.participants) {
      const live = l.requests.filter(
        (r) => r.participant_id === p.id && (r.state === "pending" || r.state === "signed"),
      );
      expect(live, `participant at place ${p.position}`).toHaveLength(1);
      expect(live[0]?.required_signer).toBe(p.is_minor ? "guardian" : "participant");
    }
    for (const r of l.requests) {
      const gens = l.deliveries.filter((d) => d.request_id === r.id);
      // Generations run 1, 2, ... with no gap and no repeat, each its own message.
      expect(gens.map((d) => d.generation)).toEqual(gens.map((_, i) => i + 1));
      for (const d of gens) {
        expect(d.dedupe_key).toBe(`waiver.request:${r.id}:${d.generation}`);
        expect(d.to_email).toBe(d.recipient_email);
      }
      // No message for the request without its delivery generation.
      expect(l.messages.filter((m) => m.subject_ref === `waiver_request:${r.id}`)).toHaveLength(
        gens.length,
      );
      // Only the newest generation of a pending request may still be waiting to go out.
      const stillQueued = gens.filter((d) => d.state === "queued" || d.state === "sending");
      if (r.state !== "pending") expect(stillQueued).toEqual([]);
      else expect(stillQueued.every((d) => d.generation === gens.length)).toBe(true);
    }
  }

  it(
    "keeps one live request per participant and one email per generation while hooks and party changes race",
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const booked = await book(world, T, nextTrip(), 4, hooks);
        const tag = `${round}-${randomUUID().slice(0, 6)}`;
        const ida = adult("Ida Unassigned", uniqueEmail(`ida.${tag}`));
        // Named while no hook ran, as if before the waiver applied: no request yet.
        const idaId = await name(world, T.id, booked.bookingId, 1, ida, {});
        const nedId = await name(world, T.id, booked.bookingId, 2, adult("Ned Named"), hooks);
        const guardian = { name: "Gia Guardian", email: uniqueEmail(`gia.${tag}`) };
        const confirmed: BookingConfirmedEvent = {
          bookingId: booked.bookingId,
          checkoutSessionId: booked.checkoutSessionId,
          tripId: booked.tripId,
          productId: T.products.shared,
          partySize: 4,
          reacquired: false,
        };

        const put = (position: number, details: ParticipantDetails) => async () => {
          const ctx = guestCtx(T.id);
          return inTenantTransaction(world.db, ctx, async (trx) => {
            await start.arrive();
            return putParticipant(trx, ctx, { bookingId: booked.bookingId, position, details }, hooks);
          });
        };
        const hook = (run: (h: Required<BookingHooks>) => Parameters<typeof inTenantTransaction>[2]) =>
          async () => {
            const ctx = systemCtx(T.id, "checkout-sweep");
            return inTenantTransaction(world.db, ctx, async (trx) => {
              await start.arrive();
              return (run(hooks as Required<BookingHooks>) as (t: typeof trx) => Promise<unknown>)(
                trx,
              );
            });
          };
        const contenders: (() => Promise<unknown>)[] = [
          // The confirmation's hook, retried twice, as the sweep would after a crash.
          hook((h) => (trx) => h.bookingConfirmed(trx, systemCtx(T.id), confirmed)),
          hook((h) => (trx) => h.bookingConfirmed(trx, systemCtx(T.id), confirmed)),
          // A participant added twice with the same details.
          put(3, adult("Ola Added")),
          put(3, adult("Ola Added")),
          // The unassigned participant's address corrected.
          put(1, adult("Ida Unassigned", uniqueEmail(`ida.new.${tag}`))),
          // A named adult turns out to be a minor.
          put(2, minor("Ned Named", guardian)),
          // A retried addition hook for someone who already has a request.
          hook((h) => (trx) =>
            h.participantAdded(trx, systemCtx(T.id), {
              bookingId: booked.bookingId,
              participantId: nedId,
              position: 2,
            }),
          ),
          // A minor added at the last place.
          put(4, minor("Pip Fourth", guardian)),
        ];
        const start = barrier(contenders.length);
        const outcomes = await Promise.all(contenders.map((run) => settle(run())));
        expect(
          outcomes.filter((o) => !o.ok),
          "no contender fails",
        ).toEqual([]);

        const l = await ledger(booked.bookingId);
        expect(l.participants.map((p) => p.position)).toEqual([1, 2, 3, 4]);
        expectConsistent(l);
        // Ned's adult request ended when he became a minor; his guardian's began.
        const ned = l.requests.filter((r) => r.participant_id === nedId);
        expect(ned.map((r) => [r.required_signer, r.state, r.revoked_reason])).toEqual([
          ["participant", "revoked", "participant_changed"],
          ["guardian", "pending", null],
        ]);
        // Ida's live request goes, last, to the corrected address, whichever ran first.
        const idaLive = l.requests.find((r) => r.participant_id === idaId && r.state === "pending");
        const idaSends = l.deliveries.filter((d) => d.request_id === idaLive?.id);
        expect(idaSends.at(-1)?.recipient_email).toBe(l.participants[0]?.email);
        expect(idaSends.filter((d) => d.state === "queued")).toHaveLength(1);
        expect(l.requests).toHaveLength(5);

        // A retried hook creates nothing and sends nothing.
        const before = JSON.stringify(await ledger(booked.bookingId));
        const ctx = systemCtx(T.id, "retry");
        await inTenantTransaction(world.db, ctx, async (trx) => {
          await hooks.bookingConfirmed?.(trx, ctx, confirmed);
          for (const p of l.participants) {
            await hooks.participantAdded?.(trx, ctx, {
              bookingId: booked.bookingId,
              participantId: p.id,
              position: p.position,
            });
          }
          const again = await assignBookingWaivers(trx, ctx, deps, { bookingId: booked.bookingId });
          expect(again.created).toEqual([]);
          expect(again.alreadyAssigned).toBe(4);
        });
        expect(JSON.stringify(await ledger(booked.bookingId))).toBe(before);
      }
    },
    300_000,
  );

  it(
    "assigns the same way for a booking the webhook confirmed and one the sweep confirmed from a received event",
    async () => {
      // The webhook route: the payment event is recorded and processed with the hooks.
      const viaWebhook = await book(world, T, nextTrip(), 3, hooks);

      // The sweep: a worker recorded the event and stopped while confirming it.
      const provider = fakeProvider(world.db);
      const tripId = nextTrip();
      const quote = await quoteFor(world.db, T.id, tripId, 3);
      const gctx = guestContext(T.id);
      const created = await inTenantTransaction(world.db, gctx, (trx) =>
        createCheckoutSession(trx, gctx, {
          quoteId: quote.quoteId,
          acceptedPolicyVersion: quote.policy.version,
          booker: { name: "Synthetic Booker", email: "synthetic.booker@example.test" },
          secret: newSecret(),
          clientAddress: null,
          provider: "fake",
          minimumAmount: FAKE_MINIMUM_AMOUNT,
        }),
      );
      if (created.kind !== "created") throw new Error(JSON.stringify(created));
      const ready = await ensureProviderPayment(world.db, provider, gctx, created.session.id);
      if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
      const settled = await provider.settlePayment(T.id, ready.paymentRef, "succeeded", Date.now());
      if (settled.kind === "not_found") throw new Error("payment did not settle");
      const event = await verifiedFakeEvent(provider, settled.event.body);
      const crashing: BookingHooks = {
        async bookingConfirmed() {
          throw new Error("the worker stopped after recording the event");
        },
      };
      await expect(
        handleVerifiedEvent(world.db, provider, event, {
          requestId: `wh-${randomUUID()}`,
          hooks: crashing,
        }),
      ).rejects.toThrow(/worker stopped/);
      const [inbox] = await world.admin<{ processing_state: string }[]>`
        select processing_state from public.provider_events
         where provider = 'fake' and event_id = ${event.eventId}`;
      expect(inbox?.processing_state).toBe("received");
      const report = await sweepCheckouts(world.db, {
        runId: `sweep-${randomUUID()}`,
        provider,
        hooks,
        graceSeconds: 0,
        budgetMs: 90_000,
      });
      expect(report.reprocessed).toBeGreaterThanOrEqual(1);
      const [swept] = await world.admin<{ id: string; state: string }[]>`
        select id, state from public.bookings where checkout_session_id = ${created.session.id}`;
      expect(swept?.state).toBe("confirmed");
      const viaSweep = swept?.id ?? "";

      // The same party on both.
      const party: ParticipantDetails[] = [
        adult("Mae Matrix", "mae.matrix@example.test"),
        minor("Moe Matrix", { name: "Gil Matrix", email: "gil.matrix@example.test" }),
        adult("Noa Matrix", null),
      ];
      for (const bookingId of [viaWebhook.bookingId, viaSweep]) {
        for (const [i, details] of party.entries()) {
          await nameParticipant(world.db, T.id, bookingId, i + 1, details, hooks);
        }
      }
      const shape = async (bookingId: string) => {
        const l = await ledger(bookingId);
        expectConsistent(l);
        return l.participants.map((p) => {
          const request = l.requests.find((r) => r.participant_id === p.id);
          return {
            position: p.position,
            signer: request?.required_signer,
            state: request?.state,
            version: request?.v,
            sends: l.deliveries
              .filter((d) => d.request_id === request?.id)
              .map((d) => [d.generation, d.kind, d.recipient_email, d.state]),
          };
        });
      };
      const webhookShape = await shape(viaWebhook.bookingId);
      expect(webhookShape).toEqual([
        {
          position: 1,
          signer: "participant",
          state: "pending",
          version: 1,
          sends: [[1, "initial", "mae.matrix@example.test", "queued"]],
        },
        {
          position: 2,
          signer: "guardian",
          state: "pending",
          version: 1,
          sends: [[1, "initial", "gil.matrix@example.test", "queued"]],
        },
        { position: 3, signer: "participant", state: "pending", version: 1, sends: [] },
      ]);
      expect(await shape(viaSweep)).toEqual(webhookShape);
      const statuses = async (bookingId: string) =>
        (
          await inTenantTransaction(world.db, systemCtx(T.id), (trx) =>
            listBookingWaivers(trx, T.id, bookingId),
          )
        )?.participants.map((p) => [p.position, p.status]);
      expect(await statuses(viaSweep)).toEqual(await statuses(viaWebhook.bookingId));
      expect(await statuses(viaSweep)).toEqual([
        [1, "waiting"],
        [2, "waiting"],
        [3, "no_address"],
      ]);

      // The provider's duplicate delivery of the event changes nothing.
      const before = JSON.stringify(await ledger(viaSweep));
      const duplicate = await handleVerifiedEvent(world.db, provider, event, {
        requestId: `wh-${randomUUID()}`,
        hooks,
      });
      expect(duplicate).toMatchObject({ kind: "processed", duplicate: true });
      expect(JSON.stringify(await ledger(viaSweep))).toBe(before);
    },
    240_000,
  );

  it(
    "moves a participant assigned while a publish that moves unsigned work commits to the new version too",
    async () => {
      const t = await createWaiverFixture(world.admin, world.db, "wva-pub", { days: 3 });
      const booked = await book(world, t, t.trips.shared[0] ?? "", 2, hooks);
      // The addition is held open right after its waiver hook assigned the version in effect.
      const assigned = gate();
      const release = gate();
      const holding: BookingHooks = {
        ...hooks,
        async participantAdded(trx, ctx, event) {
          await hooks.participantAdded?.(trx, ctx, event);
          assigned.open();
          await release.opened;
        },
      };
      const adding = settle(
        nameParticipant(world.db, t.id, booked.bookingId, 1, adult("Val Version"), holding),
      );
      try {
        await within(assigned.opened, 60_000, "the addition's assignment");
        const ctx = systemCtx(t.id, "owner");
        const published = await within(
          inTenantTransaction(world.db, ctx, (trx) =>
            publishWaiverTemplateVersion(trx, ctx, deps, {
              templateId: t.templateId,
              text: { ...FIXTURE_TEXT, body: `${FIXTURE_TEXT.body}\n\nRevised synthetic paragraph.` },
              reason: "Synthetic revision",
              reassignUnsigned: true,
            }),
          ),
          60_000,
          "the publish",
        );
        expect(published).toMatchObject({ kind: "published", version: 2 });
      } finally {
        release.open();
      }
      expect((await adding).ok).toBe(true);
      // The publisher asked that unsigned work move to version 2. The request
      // assigned beside the publish is unsigned, for a trip that has not
      // started, and no later step will move it.
      const live = await world.admin<{ v: number; state: string }[]>`
        select template_version as v, state from public.waiver_requests
         where booking_id = ${booked.bookingId} and state in ('pending', 'signed')`;
      expect(live).toEqual([{ v: 2, state: "pending" }]);
    },
    180_000,
  );
});
