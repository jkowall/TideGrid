import type { BookingHooks } from "@tidegrid/domain-booking";
import { createWaiverHooks, defaultWaiverDeps } from "@tidegrid/domain-waivers";
import type { AppDeps } from "./context.ts";
import type { Bindings } from "./env.ts";

/**
 * The booking lifecycle hooks (lane 1 contract, packages/domain-booking/src/hooks.ts)
 * that every path confirming a booking or changing its party runs, inside its
 * own transaction: the payment webhook route (which the fake provider's
 * delivery also goes through), the checkout sweep in the cron, and the guest's
 * participant and cancellation routes.
 *
 * This is the one place to attach them. The waiver module (G2.15) returns its
 * hooks here, so a confirmed booking and an added participant get their waiver
 * assignments atomically on every path; a corrected participant follows, and
 * a canceled booking ends its waivers. Nothing else in the API changes.
 */
export function bookingHooks(_env: Bindings): BookingHooks {
  return createWaiverHooks(defaultWaiverDeps);
}

/** A test's hooks when it passes them, otherwise the configured ones. */
export function bookingHooksFor(env: Bindings, deps: AppDeps): BookingHooks {
  return deps.bookingHooks ?? bookingHooks(env);
}
