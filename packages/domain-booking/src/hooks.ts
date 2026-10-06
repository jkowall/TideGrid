/**
 * Booking lifecycle hooks (lane 1 contract, G2.11c). Each hook runs inside
 * the transaction that makes the change, after the change's own rows are
 * written and before commit, under the same tenant context. Whatever a hook
 * writes commits or rolls back with the change; a hook that throws rolls the
 * whole change back.
 *
 * They exist so the waiver module (G2.15) can assign waivers atomically when
 * a booking is confirmed and when a participant is added, as the architecture
 * requires, without this package depending on it. The API wires one set of
 * hooks for every path that confirms a booking or changes its party (the
 * webhook route, the checkout sweep, and the guest's management routes) in
 * apps/api-worker/src/booking-hooks.ts; tests and the seed pass their own.
 *
 * Rules for an implementation:
 *
 * - Use the transaction and context it is given; never open another
 *   transaction or call a provider from a hook. Enqueue email with
 *   `enqueueMessage(trx, ctx, ...)` from @tidegrid/domain-messaging, which
 *   commits with the change.
 * - Events carry ids only. Read what else you need through the transaction:
 *   `listParticipants(trx, tenantId, bookingId)` for the party.
 * - `bookingConfirmed` must not refuse. Payment and confirmation never depend
 *   on waivers (docs/v2/02-product-scope.md); a throw there rolls back a
 *   confirmation whose money has moved, leaves the provider event received,
 *   and the checkout sweep retries it until it succeeds.
 * - `participantAdded` and `participantUpdated` may refuse a change by
 *   throwing `BookingHookRefusal`; the API answers 409 with its code and
 *   nothing is written. Use it sparingly, for a rule the guest can act on.
 * - `bookingCanceled` runs after the booking is canceled and its seats are
 *   released: stop reminders, revoke links. It must not refuse.
 * - Hooks run on the lock order of the change that calls them (checkout
 *   session, booking, payment, trip, hold). Lock only rows your own module
 *   owns, after those.
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";

export interface BookingConfirmedEvent {
  bookingId: string;
  checkoutSessionId: string;
  tripId: string;
  productId: string;
  partySize: number;
  /** Confirmed after its hold had expired, by taking the seats again. */
  reacquired: boolean;
}

export interface ParticipantEvent {
  bookingId: string;
  participantId: string;
  /** The participant's place in the party, 1 to the party size. */
  position: number;
}

/** A participant's fields, named for the change events; never their values. */
export type ParticipantField = "name" | "isMinor" | "email" | "guardianName" | "guardianEmail";

export interface ParticipantUpdatedEvent extends ParticipantEvent {
  /** Which fields changed, in this order: name, isMinor, email, guardianName, guardianEmail. */
  changed: ParticipantField[];
}

export interface BookingCanceledEvent {
  bookingId: string;
  cancellationId: string;
  /** The refund the cancellation requested; null when its policy gave nothing back. */
  refundId: string | null;
}

export interface BookingHooks {
  bookingConfirmed?(
    trx: TenantTransaction,
    ctx: TenantContext,
    event: BookingConfirmedEvent,
  ): Promise<void>;
  participantAdded?(
    trx: TenantTransaction,
    ctx: TenantContext,
    event: ParticipantEvent,
  ): Promise<void>;
  participantUpdated?(
    trx: TenantTransaction,
    ctx: TenantContext,
    event: ParticipantUpdatedEvent,
  ): Promise<void>;
  bookingCanceled?(
    trx: TenantTransaction,
    ctx: TenantContext,
    event: BookingCanceledEvent,
  ): Promise<void>;
}

/** No hooks: what the domain functions use when the caller passes none. */
export const noBookingHooks: BookingHooks = Object.freeze({});

/**
 * A hook's refusal of a participant change the guest can act on. The API
 * answers 409 with `code` (lowercase snake case) and `message`, and the
 * change rolls back. Only `participantAdded` and `participantUpdated` may
 * throw it.
 */
export class BookingHookRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BookingHookRefusal";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
      throw new TypeError("a refusal code is lowercase snake case, at most 64 characters");
    }
  }
}
