/**
 * The deployments a test-mode payment provider may run in: the fake, and the
 * Stripe adapter with a test key. Anything else fails closed, an unset or
 * misspelled ENVIRONMENT included, so a configuration that forgets to name
 * itself never confirms bookings with no money moving. Production is refused
 * with its own reason; every other value is unknown.
 */
export const TEST_PAYMENT_ENVIRONMENTS = ["local", "preview", "staging"] as const;

export type TestPaymentEnvironment = (typeof TEST_PAYMENT_ENVIRONMENTS)[number];

export function isTestPaymentEnvironment(value: unknown): value is TestPaymentEnvironment {
  return (
    typeof value === "string" && (TEST_PAYMENT_ENVIRONMENTS as readonly string[]).includes(value)
  );
}
