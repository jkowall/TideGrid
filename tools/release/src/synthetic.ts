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
  fetch: Fetch;
  now: () => number;
}

export type SyntheticStep = "health" | "trips" | "offer" | "quote" | "checkout" | "cancel";

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

/** The status and the API's error code when it gave one; never the message. */
async function why(res: Response): Promise<string> {
  let code = "";
  try {
    const body = (await res.json()) as { error?: { code?: unknown }; code?: unknown };
    const raw = body?.error?.code ?? body?.code;
    if (typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw)) code = ` ${raw}`;
  } catch {
    // Not JSON: the status alone.
  }
  return `HTTP ${res.status}${code}`;
}

export async function runSynthetic(o: SyntheticOptions): Promise<SyntheticResult> {
  const ms: SyntheticResult["ms"] = {};
  const base = o.api.replace(/\/+$/, "");
  const headers = (extra: Record<string, string> = {}) => ({
    Origin: o.origin,
    Accept: "application/json",
    ...extra,
  });

  async function step<T>(name: SyntheticStep, run: () => Promise<T>): Promise<T> {
    const started = o.now();
    try {
      return await run();
    } finally {
      ms[name] = Math.max(0, Math.round(o.now() - started));
    }
  }

  async function expectJson(name: SyntheticStep, res: Response, status: number) {
    if (res.status !== status) throw new StepFailure(name, await why(res));
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new StepFailure(name, `HTTP ${res.status} not JSON`);
    }
  }

  let opened: { id: string; secret: string } | null = null;
  try {
    await step("health", async () => {
      const body = await expectJson("health", await o.fetch(`${base}/v1/health`), 200);
      if (body.database !== "ok")
        throw new StepFailure("health", `database ${String(body.database)}`);
    });

    const trip = await step("trips", async () => {
      const from = localDate(o.now());
      const to = localDate(o.now() + o.days * 86_400_000);
      const res = await o.fetch(`${base}/v1/public/trips?from=${from}&to=${to}&party=1`, {
        headers: headers(),
      });
      const body = (await expectJson("trips", res, 200)) as {
        trips?: { tripId: string; salesCloseAt: string; product: { kind: string } }[];
      };
      const open = (body.trips ?? []).filter(
        (t) => Date.parse(t.salesCloseAt) > o.now() + salesMargin,
      );
      // Shared seats first: a charter holds the whole boat while the check runs.
      const pick = open.find((t) => t.product.kind === "shared_seat") ?? open[0];
      if (!pick) throw new StepFailure("trips", "no bookable trip in range");
      return pick;
    });

    const offer = await step("offer", async () => {
      const res = await o.fetch(`${base}/v1/public/trips/${trip.tripId}/offer`, {
        headers: headers(),
      });
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
          ? { kind: "charter", guests: Math.max(1, offer.product.minPartySize) }
          : { kind: "tickets", tickets: [{ code: ticket.code, quantity: 1 }] };
      const res = await o.fetch(`${base}/v1/public/quotes`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json", "Idempotency-Key": randomUUID() }),
        body: JSON.stringify({ tripId: trip.tripId, party, addOns: [] }),
      });
      const body = (await expectJson("quote", res, 201)) as { quote?: { quoteId: string } };
      if (!body.quote?.quoteId) throw new StepFailure("quote", "no quote id");
      return body.quote;
    });

    await step("checkout", async () => {
      const secret = randomBytes(32).toString("base64url");
      const res = await o.fetch(`${base}/v1/public/checkout-sessions`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json", "Idempotency-Key": randomUUID() }),
        body: JSON.stringify({
          quoteId: quote.quoteId,
          acceptedPolicyVersion: offer.policy.version,
          booker: syntheticBooker,
          checkoutSecret: secret,
        }),
      });
      const body = (await expectJson("checkout", res, 201)) as {
        checkoutSession?: { id: string; state: string };
        payment?: unknown;
      };
      if (!body.checkoutSession?.id) throw new StepFailure("checkout", "no checkout id");
      opened = { id: body.checkoutSession.id, secret };
      if (body.checkoutSession.state !== "open") {
        throw new StepFailure("checkout", `state ${body.checkoutSession.state}`);
      }
      // The provider payment exists: the payment provider answered.
      if (!body.payment) throw new StepFailure("checkout", "no provider payment");
    });
  } catch (err) {
    const failure =
      err instanceof StepFailure
        ? err
        : new StepFailure(
            (Object.keys(ms).at(-1) as SyntheticStep | undefined) ?? "health",
            (err as Error).name === "TimeoutError" ? "timeout" : "network error",
          );
    const cancel = await cancelOpened(opened);
    return {
      outcome: "fail",
      failedStep: failure.step,
      reason: cancel ? `${failure.message}; cancel ${cancel}` : failure.message,
      ms,
    };
  }

  const cancelProblem = await step("cancel", () => cancelOpened(opened));
  if (cancelProblem) return { outcome: "fail", failedStep: "cancel", reason: cancelProblem, ms };
  return { outcome: "pass", failedStep: null, reason: null, ms };

  /** Null when canceled (or nothing to cancel); otherwise why not. */
  async function cancelOpened(c: { id: string; secret: string } | null): Promise<string | null> {
    if (!c) return null;
    try {
      const res = await o.fetch(`${base}/v1/public/checkout-sessions/${c.id}/cancel`, {
        method: "POST",
        headers: headers({ Authorization: `Bearer ${c.secret}` }),
      });
      if (res.status !== 200) return await why(res);
      const body = (await res.json()) as { checkoutSession?: { state?: string } };
      return body.checkoutSession?.state === "canceled"
        ? null
        : `state ${String(body.checkoutSession?.state)}`;
    } catch {
      return "network error";
    }
  }
}

/** Reads and checks the environment. Exported for the unit test. */
export function optionsFromEnv(
  env: NodeJS.ProcessEnv,
): Pick<SyntheticOptions, "api" | "origin" | "days"> {
  const api = env.SYNTHETIC_API ?? "";
  const origin = env.SYNTHETIC_ORIGIN ?? "";
  const local = (u: URL) =>
    u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1";
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
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local(url))) {
      throw new Error(`${name} must be https (http only for localhost)`);
    }
    if (name === "SYNTHETIC_ORIGIN" && url.pathname !== "/") {
      throw new Error("SYNTHETIC_ORIGIN is an origin: scheme and host only");
    }
  }
  const days = Number(env.SYNTHETIC_DAYS ?? "30");
  if (!Number.isInteger(days) || days < 1 || days > 92)
    throw new Error("SYNTHETIC_DAYS is 1 to 92");
  return { api, origin: new URL(origin).origin, days };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = optionsFromEnv(process.env);
  const timed: Fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
  const result = await runSynthetic({ ...opts, fetch: timed, now: Date.now });
  console.log(JSON.stringify({ synthetic: result.outcome, ...result }));
  if (result.outcome !== "pass") process.exitCode = 1;
}
