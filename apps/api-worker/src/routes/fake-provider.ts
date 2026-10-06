import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  FakePaymentControlResponse,
  FakePaymentEventParams,
  FakePaymentParams,
  FakePaymentResponse,
  FakePaymentSettleRequest,
} from "@tidegrid/contracts";
import type { FakeEvent, FakeOutcome, FakePaymentProvider } from "@tidegrid/domain-payments";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { ApiError } from "../errors.ts";
import { fakeProviderFor } from "../payments.ts";
import { limitPublicCommand, resolvePublicTenant } from "../public-tenant.ts";
import { errorBody } from "./responses.ts";

const paymentPath = "/v1/fake-provider/payments/{paymentRef}";
const succeedPath = "/v1/fake-provider/payments/{paymentRef}/succeed";
const failPath = "/v1/fake-provider/payments/{paymentRef}/fail";
const redeliverPath = "/v1/fake-provider/payments/{paymentRef}/events/{eventId}/redeliver";

const paymentNotFound = () => new ApiError(404, "payment_not_found", "No such payment");
const clientSecretSecurity = [{ fakeClientSecret: [] }];

/**
 * The fake provider's demo controls (G2.7): what a hosted payment page and the
 * provider's dashboard would do. They exist only when PAYMENT_PROVIDER=fake,
 * which a production configuration refuses; everywhere else every route here
 * answers 404. A caller needs the payment's client secret, which only the
 * guest who opened the checkout received, at the operator's own origin. A
 * control never changes TideGrid's records: it settles the fake payment and
 * posts the signed event to the real webhook route, which decides everything.
 */
export function registerFakeProviderRoutes(app: OpenAPIHono<AppEnv>) {
  app.use("/v1/fake-provider/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "fakeClientSecret", {
    type: "http",
    scheme: "bearer",
    description: "The payment's client secret from the checkout response (fake provider only)",
  });

  /** The fake, the tenant from the Origin, and a client secret that belongs to the payment. */
  async function authorize(c: Context<AppEnv>, paymentRef: string, command: boolean) {
    const fake = fakeProviderFor(c);
    if (!fake) throw new ApiError(404, "not_found", "No such route");
    const tenantId = await resolvePublicTenant(c);
    if (command) await limitPublicCommand(c, tenantId);
    const match = /^Bearer (\S{1,200})$/.exec(c.req.header("authorization") ?? "");
    if (!match?.[1]) {
      throw new ApiError(401, "client_secret_required", "Send the payment's client secret");
    }
    if (!(await fake.checkClientSecret(paymentRef, match[1]))) throw paymentNotFound();
    return { fake, tenantId };
  }

  /** Post a signed event to the real webhook route, through the whole app, as the provider would. */
  async function deliver(c: Context<AppEnv>, fake: FakePaymentProvider, event: FakeEvent) {
    const signature = await fake.signDelivery(event.body, Date.now());
    const response = await app.fetch(
      new Request(new URL("/v1/webhooks/payments/fake", c.req.url), {
        method: "POST",
        headers: { "content-type": "application/json", [signature.name]: signature.value },
        body: event.body,
      }),
      c.env,
      c.executionCtx,
    );
    const json = (await response.json().catch(() => null)) as {
      outcome?: unknown;
      duplicate?: unknown;
    } | null;
    return {
      status: response.status,
      outcome: typeof json?.outcome === "string" ? json.outcome : null,
      duplicate: typeof json?.duplicate === "boolean" ? json.duplicate : null,
    };
  }

  const eventView = (event: FakeEvent) => ({
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
  });

  const readRoute = createRoute({
    method: "get",
    path: paymentPath,
    tags: ["fake-provider"],
    summary: "A fake payment and its events (fake provider only)",
    description:
      "Exists only when PAYMENT_PROVIDER=fake; refused in production. Resolves the browser Origin and needs the payment's client secret as a bearer token.",
    security: clientSecretSecurity,
    request: { params: FakePaymentParams },
    responses: {
      200: {
        content: { "application/json": { schema: FakePaymentResponse } },
        description: "The payment",
      },
      401: errorBody("No client secret"),
      404: errorBody("Not the fake provider, no such tenant hostname, or no such payment"),
    },
  });

  app.openapi(readRoute, async (c) => {
    const { paymentRef } = c.req.valid("param");
    const { fake, tenantId } = await authorize(c, paymentRef, false);
    const payment = await fake.getPayment(tenantId, paymentRef);
    if (!payment) throw paymentNotFound();
    return c.json(
      {
        payment: {
          paymentRef: payment.paymentRef,
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency,
          amountRefunded: payment.amountRefunded,
          createdAt: payment.createdAt,
          events: payment.events.map(eventView),
        },
      },
      200,
    );
  });

  const settleRoute = (path: string, outcome: FakeOutcome) =>
    createRoute({
      method: "post",
      path,
      tags: ["fake-provider"],
      summary:
        outcome === "succeeded"
          ? "Pay a fake payment (fake provider only)"
          : "Decline a fake payment (fake provider only)",
      description: `Exists only when PAYMENT_PROVIDER=fake; refused in production. Settles the payment as ${outcome}, once: a payment that already settled keeps its first outcome. Then, unless deliver is false, posts the signed event to the real webhook route and reports what it answered. Holding the event back lets a demo deliver it later, late, twice, or out of order with redeliver.`,
      security: clientSecretSecurity,
      request: {
        params: FakePaymentParams,
        body: {
          required: false,
          content: { "application/json": { schema: FakePaymentSettleRequest } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: FakePaymentControlResponse } },
          description: "The payment's outcome event and its delivery",
        },
        401: errorBody("No client secret"),
        404: errorBody("Not the fake provider, no such tenant hostname, or no such payment"),
        429: errorBody("Too many requests (rate_limited)"),
      },
    });

  for (const [path, outcome] of [
    [succeedPath, "succeeded"],
    [failPath, "failed"],
  ] as const) {
    app.openapi(settleRoute(path, outcome), async (c) => {
      const { paymentRef } = c.req.valid("param");
      const body = await c.req.json().catch(() => ({}));
      const parsed = FakePaymentSettleRequest.safeParse(body ?? {});
      if (!parsed.success) {
        throw new ApiError(400, "validation_failed", "Request did not match the contract");
      }
      const { fake, tenantId } = await authorize(c, paymentRef, true);
      const settled = await fake.settlePayment(tenantId, paymentRef, outcome, Date.now());
      if (settled.kind === "not_found") throw paymentNotFound();
      const delivery = parsed.data.deliver ? await deliver(c, fake, settled.event) : null;
      return c.json(
        {
          event: eventView(settled.event),
          alreadySettled: settled.kind === "already_settled",
          delivery,
        },
        200,
      );
    });
  }

  const redeliverRoute = createRoute({
    method: "post",
    path: redeliverPath,
    tags: ["fake-provider"],
    summary: "Deliver a stored fake event again (fake provider only)",
    description:
      "Exists only when PAYMENT_PROVIDER=fake; refused in production. Posts the stored event, byte for byte, with a fresh signature, as a provider's retry would: a duplicate, a late delivery, or one out of order.",
    security: clientSecretSecurity,
    request: { params: FakePaymentEventParams },
    responses: {
      200: {
        content: { "application/json": { schema: FakePaymentControlResponse } },
        description: "The event and its delivery",
      },
      401: errorBody("No client secret"),
      404: errorBody("Not the fake provider, no such tenant hostname, payment, or event"),
      429: errorBody("Too many requests (rate_limited)"),
    },
  });

  app.openapi(redeliverRoute, async (c) => {
    const { paymentRef, eventId } = c.req.valid("param");
    const { fake, tenantId } = await authorize(c, paymentRef, true);
    const event = await fake.findEvent(tenantId, paymentRef, eventId);
    if (!event) throw new ApiError(404, "event_not_found", "No such event");
    return c.json(
      { event: eventView(event), alreadySettled: true, delivery: await deliver(c, fake, event) },
      200,
    );
  });
}
