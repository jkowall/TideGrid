import type { FakeEvent, FakePaymentProvider } from "@tidegrid/domain-payments";
import type { Context } from "hono";
import type { AppEnv } from "./context.ts";

/** What the app answers a request with: the whole app, middleware included. */
export interface AppFetcher {
  fetch(
    request: Request,
    env: AppEnv["Bindings"],
    executionCtx: Context<AppEnv>["executionCtx"],
  ): Response | Promise<Response>;
}

export interface FakeDeliveryResult {
  status: number;
  outcome: string | null;
  duplicate: boolean | null;
}

/**
 * Post a fake provider's stored event to the real webhook route, through the
 * whole app, as the provider would: the exact stored body with a fresh
 * signature and no Origin. The webhook verifies it, records it once by event
 * id, and decides everything. Used by the guest's fake pay controls (G2.7)
 * and by staff's test payment (G2.12d). The webhook request opens its own
 * database connection, so the caller must hold no open transaction.
 */
export async function deliverFakeEvent(
  app: AppFetcher,
  c: Context<AppEnv>,
  fake: FakePaymentProvider,
  event: FakeEvent,
): Promise<FakeDeliveryResult> {
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
