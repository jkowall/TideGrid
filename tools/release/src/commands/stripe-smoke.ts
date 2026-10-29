/**
 * nov1 stripe-smoke (P9, gate A11, which waits on D15). The server-side Stripe
 * test-mode run: no browser payment exists, because the G2.11 Element is not
 * built (12:173).
 *
 * It refuses any key not prefixed sk_test_ or rk_test_, and makes no Stripe
 * CLI call: it never spawns anything, so --api-key and --live never appear.
 * The key is read from STRIPE_SECRET_KEY in the owner's shell and sent only as
 * a bearer header to api.stripe.com. Account ids are read from
 * STRIPE_ACCT_<SLUG> and redacted in every line printed or journaled.
 *
 * The run: GET /v1/account to see which account the key belongs to; a guest
 * checkout through the public API with a preview Origin; confirm its
 * PaymentIntent on the connected account, first with a declining card, then
 * with pm_card_visa; wait for the webhook to confirm the booking; cancel through
 * the from-checkout management session and wait for the refund. The
 * `stripe events resend` leg is the owner's own command (A14), printed here.
 */
import { randomUUID } from "node:crypto";
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, type Plan, poll, printPlan, Refusal } from "../core.ts";
import { liveGate } from "../gate.ts";
import {
  checkout,
  checkoutState,
  client,
  errorCode,
  findTrips,
  newCallLog,
  type Profile,
  parseHosts,
  profileFor,
  quote,
} from "../http.ts";
import { record } from "../journal.ts";
import { accountEnvName, checkAccountRef } from "./payment-account.ts";

export const stripeApi = "https://api.stripe.com";
export const stripeVersion = "2026-09-30.endive";

/** Test keys only, in the smoke as in the Worker (apps/api-worker/src/payments.ts:67-73). */
export function checkTestKey(key: string | undefined): string {
  if (!key) throw new Refusal("STRIPE_SECRET_KEY is not set in this shell");
  if (!/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(key)) {
    throw new Refusal(
      "stripe-smoke takes a test key only (sk_test_ or rk_test_); live keys are refused",
    );
  }
  return key;
}

export function stripeSmokePlan(slug: string): Plan {
  return {
    command: `stripe-smoke --tenant ${slug}`,
    target: `${stripeApi} (test mode) and https://api.tidegrid.us`,
    notes: [
      "Needs PAYMENT_PROVIDER=stripe deployed (C5), both Stripe secrets on the API, and an active stripe payment account row.",
      "Never spawns the Stripe CLI; the resend leg is printed for the owner to run.",
    ],
    steps: [
      {
        id: "1",
        title: "Which account the key belongs to",
        gate: "A11",
        commands: [`GET ${stripeApi}/v1/account`],
        envNames: ["STRIPE_SECRET_KEY"],
        expect: ["the platform account, not a connected one"],
        rollback: ["not applicable (read-only)"],
      },
      {
        id: "2",
        title: "A guest checkout with the preview Origin",
        gate: "A11",
        commands: ["POST /v1/public/quotes", "POST /v1/public/checkout-sessions"],
        expect: ["payment.provider stripe, a pi_ paymentRef"],
        rollback: ["the hold expires in 15 minutes"],
      },
      {
        id: "3",
        title: "Confirm with a declining card, then pm_card_visa",
        gate: "A11",
        commands: [
          `POST ${stripeApi}/v1/payment_intents/<pi>/confirm (Stripe-Account: $${accountEnvName(slug)})`,
        ],
        envNames: ["STRIPE_SECRET_KEY", accountEnvName(slug)],
        expect: ["402 card_declined, then succeeded"],
        rollback: ["step 5 refunds it"],
      },
      {
        id: "4",
        title: "The webhook confirms the booking",
        commands: ["GET /v1/public/checkout-sessions/<id> until confirmed"],
        expect: ["confirmed within 60 s; one inbox row per event"],
        rollback: ["step 5"],
      },
      {
        id: "5",
        title: "Cancel and see the refund settle",
        commands: [
          "POST /v1/public/checkout-sessions/<id>/manage-session",
          "POST /v1/public/manage/cancellation",
        ],
        expect: ["canceled; refund succeeded"],
        rollback: ["none needed: test mode"],
      },
      {
        id: "6",
        title: "Redelivery (owner's own command, A14)",
        gate: "A14",
        commands: [
          'STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe events resend <evt_id> --account <the connected account id>  # typed by the owner; never --api-key, never --live',
        ],
        expect: [
          "no payload_mismatch: the booking stays confirmed then canceled, the inbox records a duplicate",
        ],
        rollback: ["not applicable"],
      },
    ],
  };
}

async function stripe(
  deps: Deps,
  key: string,
  method: string,
  path: string,
  account?: string,
  form?: Record<string, string>,
) {
  const res = await deps.fetch(`${stripeApi}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "stripe-version": stripeVersion,
      ...(account ? { "stripe-account": account } : {}),
      ...(form
        ? {
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": `nov1-${randomUUID()}`,
          }
        : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

export interface StripeSmokeResult {
  steps: { step: string; ok: boolean; detail: string }[];
  eventHint: string | null;
}

export async function runStripeSmoke(
  deps: Deps,
  profile: Profile,
  slug: string,
): Promise<StripeSmokeResult> {
  const key = checkTestKey(deps.env.STRIPE_SECRET_KEY);
  const name = accountEnvName(slug);
  const account = checkAccountRef(deps.env[name], name);
  const steps: StripeSmokeResult["steps"] = [];
  const step = (s: string, ok: boolean, detail: string) => {
    steps.push({ step: s, ok, detail });
    if (!ok) throw new Failure(`stripe-smoke ${s}: ${detail}`);
  };

  const who = await stripe(deps, key, "GET", "/v1/account");
  const platform = typeof who.json.id === "string" ? who.json.id : "";
  step(
    "account",
    who.status === 200 && platform !== account && platform.startsWith("acct_"),
    `${who.status}, the key's account is ${platform === account ? "the connected account (wrong key)" : "the platform"}`,
  );

  const host = profile.hosts.find((h) => h.slug === slug);
  if (!host) throw new Refusal(`no host given for ${slug}`);
  const call = client(deps, profile, host, newCallLog());
  const product = slug === "demo-reef" ? "Two-Tank Morning Dive" : "Sunset Harbor Cruise";
  const [trip] = await findTrips(deps, call, { product, party: 1, fromDays: 4 });
  if (!trip) throw new Failure(`no ${product} on sale`);
  const q = await quote(call, trip, 1);
  step("quote", q.status === 201, `${q.status}`);
  const { answer, open } = await checkout(call, q, `${slug}-stripe`);
  step(
    "checkout",
    Boolean(open) && open?.provider === "stripe" && /^pi_/.test(open?.paymentRef ?? ""),
    `${answer.status} ${errorCode(answer) ?? open?.provider ?? ""}`,
  );
  const pi = open?.paymentRef as string;

  const declined = await stripe(deps, key, "POST", `/v1/payment_intents/${pi}/confirm`, account, {
    payment_method: "pm_card_chargeDeclined",
  });
  const declineCode = (declined.json.error as { code?: string } | undefined)?.code;
  step(
    "decline",
    declined.status === 402 && declineCode === "card_declined",
    `${declined.status} ${declineCode ?? ""}`,
  );
  const paid = await stripe(deps, key, "POST", `/v1/payment_intents/${pi}/confirm`, account, {
    payment_method: "pm_card_visa",
  });
  step(
    "pay",
    paid.status === 200 && paid.json.status === "succeeded",
    `${paid.status} ${String(paid.json.status)}`,
  );

  const confirmed = await poll(
    deps,
    async () =>
      (await checkoutState(call, open as NonNullable<typeof open>)) === "confirmed" ? true : null,
    { intervalMs: 3_000, timeoutMs: 60_000 },
  );
  step(
    "webhook confirmed the booking",
    confirmed === true,
    confirmed ? "confirmed" : "not confirmed within 60 s",
  );

  const session = await call(
    "POST",
    `/v1/public/checkout-sessions/${open?.sessionId}/manage-session`,
    { limited: true, headers: { authorization: `Bearer ${open?.secret}` } },
  );
  const token = (session.json.session as { token?: string } | undefined)?.token;
  step("manage session", session.status === 201 && Boolean(token), `${session.status}`);
  const auth = { authorization: `Bearer ${token}` };
  const terms = await call("GET", "/v1/public/manage/cancellation", { headers: auth });
  const refundAmount = (terms.json.terms as { refundAmount?: number } | undefined)?.refundAmount;
  const canceled = await call("POST", "/v1/public/manage/cancellation", {
    limited: true,
    headers: { ...auth, "idempotency-key": `nov1-x-${randomUUID()}` },
    body: { expectedRefundAmount: refundAmount },
  });
  step("cancel", canceled.status === 200, `${canceled.status} ${errorCode(canceled) ?? ""}`);
  const refunded = await poll(
    deps,
    async () => {
      const b = await call("GET", "/v1/public/manage/booking", { headers: auth });
      const state = (b.json.refund as { state?: string } | null | undefined)?.state;
      return state === "succeeded" ? state : null;
    },
    { intervalMs: 3_000, timeoutMs: 90_000 },
  );
  step("refund", refunded === "succeeded", refunded ?? "not settled within 90 s");

  const events = await stripe(
    deps,
    key,
    "GET",
    `/v1/events?type=payment_intent.succeeded&limit=1`,
    account,
  );
  const evt = ((events.json.data as { id?: string }[] | undefined) ?? [])[0]?.id ?? null;
  return { steps, eventHint: evt };
}

export async function stripeSmoke(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["api", "hosts", "tenant", "live", "go"]);
  const slug = flag(args, "tenant") ?? "demo-harbor";
  if (slug !== "demo-harbor" && slug !== "demo-reef")
    throw new Refusal("--tenant is demo-harbor or demo-reef");
  if (!args.flags.has("live")) {
    printPlan(deps, stripeSmokePlan(slug));
    return 0;
  }
  checkTestKey(deps.env.STRIPE_SECRET_KEY);
  const profile = profileFor(
    "preview",
    flag(args, "api") ?? "https://api.tidegrid.us",
    parseHosts(flag(args, "hosts") ?? "demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us"),
  );
  await liveGate(
    deps,
    { live: true, go: flag(args, "go") },
    {
      gates: ["A11"],
      confirm: ["test mode", slug],
      action: `real Stripe test-mode calls for ${slug}`,
    },
  );
  const result = await runStripeSmoke(deps, profile, slug).catch((err) => {
    record(deps, {
      phase: "p9",
      step: "stripe-smoke",
      gate: "A11",
      result: "failed",
      note: (err as Error).message,
    });
    throw err;
  });
  for (const s of result.steps) out(deps, `PASS  ${s.step}: ${s.detail}`);
  out(
    deps,
    `A14 redelivery, the owner's own command: STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe events resend ${result.eventHint ?? "<evt_id>"} --account <$${accountEnvName(slug)}>`,
  );
  record(deps, { phase: "p9", step: "stripe-smoke", gate: "A11", result: "done" });
  return 0;
}
