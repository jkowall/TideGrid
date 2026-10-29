/**
 * Test support, reachable as `@tidegrid/domain-payments/testing`. It
 * re-exports the recorded-shape Stripe fixture and nothing else. Only tests
 * import it; runtime code never does, and `provenance.test.ts` checks that.
 */
export {
  createStripeFixture,
  type StripeEventOptions,
  type StripeFixture,
  type StripeFixtureDelivery,
  type StripeFixtureOptions,
  type StripeRecordedRequest,
  type StripeRefundStatus,
  type StripeScriptedAnswer,
} from "./stripe-fixture.ts";
