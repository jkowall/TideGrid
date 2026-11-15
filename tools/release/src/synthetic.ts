/**
 * The synthetic booking check (hosting plan, observability; goal W3-OPS-5).
 *
 *   SYNTHETIC_API=https://api.tidegrid.us \
 *   SYNTHETIC_ORIGIN=https://<synthetic tenant>.book.tidegrid.us \
 *   pnpm --silent --filter @tidegrid/release synthetic
 *
 * Walks the guest's path on one synthetic tenant, the way a browser on that
 * tenant's booking site does: health, bookable trips, the trip's offer, a
 * quote, a checkout that holds seats and creates the provider payment, then
 * cancels the checkout, which releases the seats at once and voids the order.
 * Nothing is paid, so no booking is made and no email goes to anyone. The
 * booker is a synthetic name at example.test, a domain that never receives
 * mail.
 *
 * Prints one JSON line: the outcome, the failing step if any, and each step's
 * time in milliseconds. Never prints a secret, a booker, or an id. Exits 1 on
 * any failure. A checkout it opened is always canceled, even after a failure.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SyntheticOptions {
  api: string;
  origin: string;
  /** Days ahead to look for a trip. */
  days: number;
  /** Guests to search and quote for (default 1). Set it to the synthetic
   * tenant's smallest party when its products need more than one guest. */
  party?: number;
  fetch: Fetch;
  now: () => number;
}

export type SyntheticStep =
  | "health"
  | "trips"
  | "offer"
  | "quote"
  | "checkout"
  | "cancel";

export interface SyntheticResult {
  outcome: "pass" | "fail";
  failedStep: SyntheticStep | null;
  /** A short, fixed reason: an HTTP status and error code, never a body. */
  reason: string | null;
  ms: Partial<Record<SyntheticStep, number>>;
}

export class StepFailure extends Error {
  constructor(
    readonly step: SyntheticStep,
    reason: string,
  ) {
    super(reason);
  }
}

/** Seats must still be on sale this long after the check starts. */
const salesMargin = 15 * 60 * 1000;

export const syntheticBooker = {
  name: "TideGrid Synthetic Check",
  email: "synthetic-check@example.test",
};

function localDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A server-supplied word, only when it is a plain code; never free text. */
function word(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,32}$/.test(value)
    ? value
    : "unexpected";
}

/** The status and the API's error code when it gave one; never the message. */
async function why(res: Response): Promise<string> {
  let code = "";
  try {
    const body = (await res.json()) as {
      error?: { code?: unknown };
      code?: unknown;
    };
    const raw = body?.error?.code ?? body?.code;
    if (typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw)) code = ` ${raw}`;
  } catch {
    // Not JSON: the status alone.
  }
  return `HTTP ${res.status}${code}`;
}

export async function runSynthetic(
  o: SyntheticOptions,
): Promise<SyntheticResult> {
  const ms: SyntheticResult["ms"] = {};
  const base = o.api.replace(/\/+$/, "");
  const guests = o.party ?? 1;
  const headers = (extra: Record<string, string> = {}) => ({
    Origin: o.origin,
    Accept: "application/json",
    ...extra,
  });

  async function step<T>(
    name: SyntheticStep,
    run: () => Promise<T>,
  ): Promise<T> {
    const started = o.now();
    try {
      return await run();
    } finally {
      ms[name] = Math.max(0, Math.round(o.now() - started));
    }
  }

  async function expectJson(
    name: SyntheticStep,
    res: Response,
    status: number,
  ) {
    if (res.status !== status) throw new StepFailure(name, await why(res));
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new StepFailure(name, `HTTP ${res.status} not JSON`);
    }
  }

  let opened: { id: string; secret: string } | null = null;
  // Set once a checkout request is about to go out; finds a kept checkout.
  let recover: (() => Promise<void>) | null = null;
  try {
    await step("health", async () => {
      const body = await expectJson(
        "health",
        await o.fetch(`${base}/v1/health`),
        200,
      );
      if (body.database !== "ok")
        throw new StepFailure("health", `database ${word(body.database)}`);
    });

    const trip = await step("trips", async () => {
      // The API reads from and to as tenant-local dates; a UTC date runs ahead
      // of US evenings, so start a day early. Sales times filter what is left.
      const from = localDate(o.now() - 86_400_000);
      const to = localDate(o.now() + o.days * 86_400_000);
      const res = await o.fetch(
        `${base}/v1/public/trips?from=${from}&to=${to}&party=${guests}`,
        {
          headers: headers(),
        },
      );
      const body = (await expectJson("trips", res, 200)) as {
        trips?: {
          tripId: string;
          salesCloseAt: string;
          product: { kind: string };
        }[];
      };
      const open = (body.trips ?? []).filter(
        (t) => Date.parse(t.salesCloseAt) > o.now() + salesMargin,
      );
      // Shared seats first: a charter holds the whole boat while the check runs.
      const pick =
        open.find((t) => t.product.kind === "shared_seat") ?? open[0];
      if (!pick) throw new StepFailure("trips", "no bookable trip in range");
      return pick;
    });

    const offer = await step("offer", async () => {
      const res = await o.fetch(
        `${base}/v1/public/trips/${trip.tripId}/offer`,
        {
          headers: headers(),
        },
      );
      const body = (await expectJson("offer", res, 200)) as {
        offer?: {
          tickets: { code: string }[];
          charter: unknown;
          product: { minPartySize: number };
          policy: { version: number };
        };
      };
      if (!body.offer) throw new StepFailure("offer", "no offer");
      return body.offer;
    });

    const quote = await step("quote", async () => {
      const ticket = offer.tickets[0];
      const party =
        offer.charter || !ticket
          ? {
              kind: "charter",
              guests: Math.max(guests, offer.product.minPartySize),
            }
          : {
              kind: "tickets",
              tickets: [
                {
                  code: ticket.code,
                  quantity: Math.max(guests, offer.product.minPartySize),
                },
              ],
            };
      const res = await o.fetch(`${base}/v1/public/quotes`, {
        method: "POST",
        headers: headers({
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        }),
        body: JSON.stringify({ tripId: trip.tripId, party, addOns: [] }),
      });
      const body = (await expectJson("quote", res, 201)) as {
        quote?: { quoteId: string };
      };
      if (!body.quote?.quoteId) throw new StepFailure("quote", "no quote id");
      return body.quote;
    });

    // Kept outside the step: when the answer is lost or the provider is down,
    // the checkout may exist anyway, and replaying the same key with the same
    // body returns it, so it can still be canceled.
    const checkoutKey = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const checkoutBody = JSON.stringify({
      quoteId: quote.quoteId,
      acceptedPolicyVersion: offer.policy.version,
      booker: syntheticBooker,
      checkoutSecret: secret,
    });
    const postCheckout = () =>
      o.fetch(`${base}/v1/public/checkout-sessions`, {
        method: "POST",
        headers: headers({
          "Content-Type": "application/json",
          "Idempotency-Key": checkoutKey,
        }),
        body: checkoutBody,
      });
    recover = async () => {
      // Learn the id of a checkout the server may have kept.
      try {
        const res = await postCheckout();
        if (res.status !== 200 && res.status !== 201) return;
        const body = (await res.json()) as {
          checkoutSession?: { id?: unknown };
        };
        const id = body.checkoutSession?.id;
        if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))
          opened = { id, secret };
      } catch {
        // Unknown: the checkout, if any, expires by itself.
      }
    };

    await step("checkout", async () => {
      const body = (await expectJson(
        "checkout",
        await postCheckout(),
        201,
      )) as {
        checkoutSession?: { id: string; state: string };
        payment?: unknown;
      };
      if (!body.checkoutSession?.id)
        throw new StepFailure("checkout", "no checkout id");
      opened = { id: body.checkoutSession.id, secret };
      if (body.checkoutSession.state !== "open") {
        throw new StepFailure(
          "checkout",
          `state ${word(body.checkoutSession.state)}`,
        );
      }
      // The provider payment exists: the payment provider answered.
      if (!body.payment)
        throw new StepFailure("checkout", "no provider payment");
    });
  } catch (err) {
    const failure =
      err instanceof StepFailure
        ? err
        : new StepFailure(
            (Object.keys(ms).at(-1) as SyntheticStep | undefined) ?? "health",
            (err as Error).name === "TimeoutError"
              ? "timeout"
              : err instanceof TypeError &&
                  !/fetch/i.test((err as Error).message)
                ? "unexpected response"
                : "network error",
          );
    let unknown = false;
    if (!opened && recover && failure.step === "checkout") {
      await recover();
      // Still no id: the server may have kept a checkout it could not show.
      unknown = !opened && !/^HTTP (4\d\d)/.test(failure.message);
    }
    const cancel = await cancelOpened(opened);
    const notes = [
      failure.message,
      ...(cancel ? [`cancel ${cancel}`] : []),
      ...(unknown ? ["a held checkout may remain until it expires"] : []),
    ];
    return {
      outcome: "fail",
      failedStep: failure.step,
      reason: notes.join("; "),
      ms,
    };
  }

  const cancelProblem = await step("cancel", () => cancelOpened(opened));
  if (cancelProblem)
    return { outcome: "fail", failedStep: "cancel", reason: cancelProblem, ms };
  return { outcome: "pass", failedStep: null, reason: null, ms };

  /** Null when canceled (or nothing to cancel); otherwise why not. */
  async function cancelOpened(
    c: { id: string; secret: string } | null,
  ): Promise<string | null> {
    if (!c) return null;
    try {
      const res = await o.fetch(
        `${base}/v1/public/checkout-sessions/${c.id}/cancel`,
        {
          method: "POST",
          headers: headers({ Authorization: `Bearer ${c.secret}` }),
        },
      );
      if (res.status !== 200) return await why(res);
      const body = (await res.json()) as {
        checkoutSession?: { state?: string };
      };
      return body.checkoutSession?.state === "canceled"
        ? null
        : `state ${word(body.checkoutSession?.state)}`;
    } catch {
      return "network error";
    }
  }
}

/** Reads and checks the environment. Exported for the unit test. */
export function optionsFromEnv(
  env: NodeJS.ProcessEnv,
): Pick<SyntheticOptions, "api" | "origin" | "days" | "party"> {
  const api = env.SYNTHETIC_API ?? "";
  const origin = env.SYNTHETIC_ORIGIN ?? "";
  const local = (u: URL) =>
    u.hostname === "localhost" ||
    u.hostname.endsWith(".localhost") ||
    u.hostname === "127.0.0.1";
  for (const [name, value] of [
    ["SYNTHETIC_API", api],
    ["SYNTHETIC_ORIGIN", origin],
  ] as const) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be a URL such as https://api.tidegrid.us`);
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && local(url))
    ) {
      throw new Error(`${name} must be https (http only for localhost)`);
    }
    if (name === "SYNTHETIC_ORIGIN" && url.pathname !== "/") {
      throw new Error("SYNTHETIC_ORIGIN is an origin: scheme and host only");
    }
  }
  const days = Number(env.SYNTHETIC_DAYS ?? "30");
  if (!Number.isInteger(days) || days < 1 || days > 91)
    throw new Error("SYNTHETIC_DAYS is 1 to 91");
  const party = Number(env.SYNTHETIC_PARTY ?? "1");
  if (!Number.isInteger(party) || party < 1 || party > 20)
    throw new Error("SYNTHETIC_PARTY is 1 to 20");
  return { api, origin: new URL(origin).origin, days, party };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = optionsFromEnv(process.env);
  const timed: Fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
  const result = await runSynthetic({ ...opts, fetch: timed, now: Date.now });
  console.log(JSON.stringify({ synthetic: result.outcome, ...result }));
  if (result.outcome !== "pass") process.exitCode = 1;
}
