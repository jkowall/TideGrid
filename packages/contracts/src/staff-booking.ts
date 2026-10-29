import { z } from "zod";
import {
  BookerDetails,
  BookingChannel,
  CheckoutSessionState,
  FakeDelivery,
  FakePaymentEvent,
  RefundState,
} from "./checkout.ts";

/**
 * Staff-assisted booking (G2.12d). An owner or booking staff member books for
 * a guest who phoned, emailed, or walked up, through the same chain a guest's
 * checkout takes: an offer, a stored quote, a checkout that holds the party
 * and writes the order and a pending payment, and a booking only once a
 * verified provider event says the payment succeeded. The demo takes the
 * payment with the fake provider's test control, which posts a signed event
 * to the real webhook route; nothing here marks anything paid.
 *
 * The checkout's source and opener are stamped by the database from the
 * signed-in staff member, never sent. Staff attest that they told the guest
 * the cancellation policy and read the email address back: a demo narrowing
 * of the rule that the guest accepts the policy before paying (docs/v2/12).
 * Money is integer US cents.
 */

const Uuid = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const Cents = z.number().int().describe("Integer US cents");

export const StaffCheckoutAttestations = z
  .object({
    policyToldToGuest: z
      .literal(true)
      .describe("The staff member told the guest the cancellation policy of the quote's version"),
    emailReadBack: z
      .literal(true)
      .describe(
        "The staff member read the email address back to the guest; it cannot be changed after booking",
      ),
  })
  .describe("What staff confirm before opening the checkout. Both are required");
export type StaffCheckoutAttestations = z.infer<typeof StaffCheckoutAttestations>;

export const StaffCheckoutCreateRequest = z.object({
  quoteId: Uuid.describe(
    "A quote from POST /v1/staff/tenants/{tenantId}/quotes, still within its validity",
  ),
  acceptedPolicyVersion: z
    .number()
    .int()
    .min(1)
    .describe("The policy version staff told the guest; must be the quote's"),
  booker: BookerDetails,
  channel: BookingChannel,
  attestations: StaffCheckoutAttestations,
});
export type StaffCheckoutCreateRequest = z.infer<typeof StaffCheckoutCreateRequest>;

export const StaffCheckoutParams = z.object({
  tenantId: z.string(),
  checkoutId: z.string().describe("Checkout UUID; anything else answers 404"),
});

export const StaffTestPaymentOutcome = z
  .enum(["succeed", "fail"])
  .describe("succeed takes the test payment; fail declines it");
export type StaffTestPaymentOutcome = z.infer<typeof StaffTestPaymentOutcome>;

export const StaffCheckout = z
  .object({
    id: Uuid,
    state: CheckoutSessionState,
    tripId: Uuid,
    quoteId: Uuid,
    partySize: z.number().int().min(1),
    amount: Cents.describe("What the payment charges: the quote's total"),
    currency: z.literal("USD"),
    expiresAt: Instant.describe("The seats are held until this instant"),
    createdAt: Instant,
    channel: BookingChannel,
    paymentState: z
      .enum(["pending", "succeeded", "failed"])
      .describe("succeeded only once a verified provider event says so"),
    lastTestPayment: z
      .object({ outcome: StaffTestPaymentOutcome, requestedAt: Instant })
      .nullable()
      .describe("The latest test payment staff asked for, if any"),
    booking: z
      .object({
        id: Uuid,
        reference: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
      })
      .nullable()
      .describe("Present once confirmed"),
    refund: z
      .object({ state: RefundState, amount: Cents })
      .nullable()
      .describe(
        "Present when a payment could not be honored, such as one that arrived after the hold ended",
      ),
  })
  .describe("A staff-assisted checkout as staff see it: no booker details and no provider secret");
export type StaffCheckout = z.infer<typeof StaffCheckout>;

export const StaffCheckoutResponse = z.object({ checkout: StaffCheckout });
export type StaffCheckoutResponse = z.infer<typeof StaffCheckoutResponse>;

export const StaffCheckoutCreateResponse = z.object({
  checkout: StaffCheckout.describe(
    "The checkout as it was opened. A replay returns this same snapshot; read the current state with GET",
  ),
  paymentReady: z
    .boolean()
    .describe("The provider has the payment, so a test payment can be taken"),
});
export type StaffCheckoutCreateResponse = z.infer<typeof StaffCheckoutCreateResponse>;

export const StaffTestPaymentRequest = z.object({ outcome: StaffTestPaymentOutcome });
export type StaffTestPaymentRequest = z.infer<typeof StaffTestPaymentRequest>;

export const StaffTestPaymentResponse = z
  .object({
    checkoutId: Uuid,
    outcome: StaffTestPaymentOutcome,
    event: FakePaymentEvent.describe("The payment's outcome event, as the provider signed it"),
    alreadySettled: z
      .boolean()
      .describe(
        "The payment had settled before this call, so the event is its first outcome, delivered again",
      ),
    delivery: FakeDelivery.describe(
      "What the real webhook route answered. A status other than 200 means the booking is not decided yet: send the same request again with the same Idempotency-Key",
    ),
  })
  .describe("A test payment taken or declined through the fake provider (demo only)");
export type StaffTestPaymentResponse = z.infer<typeof StaffTestPaymentResponse>;
