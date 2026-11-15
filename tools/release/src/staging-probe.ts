/**
 * Pre-pilot probes against the staging API (goal W3-PREPILOT). Staging only:
 * the API must be an api-staging host, and the restart probe restarts only a
 * compute that Neon reports on a branch named "staging" that is not the
 * project's default branch.
 *
 *   PROBE_API=https://api-staging.tidegrid.us \
 *   PROBE_ORIGIN=https://demo-harbor.book.tidegrid.us \
 *   pnpm --silent --filter @tidegrid/release staging-probe <latency|raw|restart>
 *
 * - latency: times public reads that reach the database through the Worker
 *   (trips, tenant), and records the placement header Cloudflare adds when
 *   the Worker runs away from the visitor's location.
 * - raw: read-after-write. Each pair writes a quote and reads it straight
 *   back by id; any pair that cannot read its own write fails the probe.
 *   Public writes are limited to 30 a minute for one client, so pairs are
 *   paced at one every 2.5 seconds.
 * - restart: restarts the staging compute through the Neon API (needs
 *   NEON_API_KEY, NEON_PROJECT_ID, STAGING_BRANCH_ID, STAGING_ENDPOINT_ID),
 *   then reads trips once a second until the database answers again, then
 *   runs read-after-write pairs on the new connection.
 *
 * Prints one JSON line per probe. Never prints a secret, a host other than
 * the API's, or a booker. Exits 1 when a probe fails its check.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  api: string;
  origin: string;
  fetch: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Nearest-rank percentile of sorted samples. Exported for the unit test. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? null;
}

export function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  };
}

function localDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The API's error code when it gave a plain one; never free text. */
async function code(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    const c = body.error?.code;
    return typeof c === "string" && /^[a-z_]{1,40}$/.test(c) ? c : "";
  } catch {
    return "";
  }
}

function headers(o: ProbeOptions, extra: Record<string, string> = {}) {
  return { Origin: o.origin, Accept: "application/json", ...extra };
}

function tripsUrl(o: ProbeOptions): string {
  const from = localDate(o.now() - 86_400_000);
  const to = localDate(o.now() + 30 * 86_400_000);
  return `${o.api}/v1/public/trips?from=${from}&to=${to}&party=1`;
}

async function timed(o: ProbeOptions, url: string, init: RequestInit = {}) {
  const started = o.now();
  const res = await o.fetch(url, init);
  // Read the body inside the timing: the response is not done until it arrives.
  const text = await res.text();
  return { res, text, ms: Math.round(o.now() - started) };
}

export async function latency(o: ProbeOptions, samples = 30) {
  const trips: number[] = [];
  const tenant: number[] = [];
  const placement = new Map<string, number>();
  const failures: string[] = [];
  // One warm-up each, not counted: the first request may wake the compute.
  await timed(o, tripsUrl(o), { headers: headers(o) });
  await timed(o, `${o.api}/v1/public/tenant`, { headers: headers(o) });
  for (let i = 0; i < samples; i++) {
    const a = await timed(o, tripsUrl(o), { headers: headers(o) });
    if (a.res.status === 200) trips.push(a.ms);
    else failures.push(`trips ${a.res.status}`);
    const where = a.res.headers.get("cf-placement") ?? "none";
    placement.set(where, (placement.get(where) ?? 0) + 1);
    const b = await timed(o, `${o.api}/v1/public/tenant`, { headers: headers(o) });
    if (b.res.status === 200) tenant.push(b.ms);
    else failures.push(`tenant ${b.res.status}`);
  }
  return {
    probe: "latency",
    outcome: failures.length === 0 ? "pass" : "fail",
    trips: summarize(trips),
    tenant: summarize(tenant),
    placement: Object.fromEntries(placement),
    failures: failures.slice(0, 10),
  };
}

interface QuoteTarget {
  tripId: string;
  party: unknown;
}

/** A shared-seat trip open for sale, and the party to quote for it. */
export async function quoteTarget(o: ProbeOptions): Promise<QuoteTarget> {
  const res = await o.fetch(tripsUrl(o), { headers: headers(o) });
  if (res.status !== 200) throw new Error(`trips HTTP ${res.status} ${await code(res)}`);
  const body = (await res.json()) as {
    trips?: { tripId: string; salesCloseAt: string; product: { kind: string } }[];
  };
  const open = (body.trips ?? []).filter((t) => Date.parse(t.salesCloseAt) > o.now() + 3_600_000);
  const trip = open.find((t) => t.product.kind === "shared_seat") ?? open[0];
  if (!trip) throw new Error("no bookable trip in the next 30 days");
  const offerRes = await o.fetch(`${o.api}/v1/public/trips/${trip.tripId}/offer`, {
    headers: headers(o),
  });
  if (offerRes.status !== 200) throw new Error(`offer HTTP ${offerRes.status}`);
  const { offer } = (await offerRes.json()) as {
    offer?: { tickets: { code: string }[]; charter: unknown; product: { minPartySize: number } };
  };
  if (!offer) throw new Error("no offer");
  const ticket = offer.tickets[0];
  const guests = Math.max(1, offer.product.minPartySize);
  const party =
    offer.charter || !ticket
      ? { kind: "charter", guests }
      : { kind: "tickets", tickets: [{ code: ticket.code, quantity: guests }] };
  return { tripId: trip.tripId, party };
}

/**
 * Read-after-write pairs: write a quote, then read it back at once. A 404 on
 * the read is a stale read and fails the probe. Exported for the unit test.
 */
export async function readAfterWrite(o: ProbeOptions, pairs = 20, gapMs = 2_500) {
  const target = await quoteTarget(o);
  let ok = 0;
  let stale = 0;
  let writeFailures = 0;
  const errors: string[] = [];
  const writeMs: number[] = [];
  const readMs: number[] = [];
  for (let i = 0; i < pairs; i++) {
    if (i > 0) await o.sleep(gapMs);
    const w = await timed(o, `${o.api}/v1/public/quotes`, {
      method: "POST",
      headers: headers(o, { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }),
      body: JSON.stringify({ tripId: target.tripId, party: target.party, addOns: [] }),
    });
    if (w.res.status !== 201) {
      // A refused write says nothing about consistency; counted apart.
      writeFailures++;
      errors.push(`write ${w.res.status}`);
      continue;
    }
    writeMs.push(w.ms);
    const id = (JSON.parse(w.text) as { quote?: { quoteId?: string } }).quote?.quoteId;
    if (!id) {
      errors.push("write without id");
      continue;
    }
    const r = await timed(o, `${o.api}/v1/public/quotes/${id}`, { headers: headers(o) });
    readMs.push(r.ms);
    if (r.res.status === 200) {
      const got = (JSON.parse(r.text) as { quote?: { quoteId?: string } }).quote?.quoteId;
      if (got === id) ok++;
      else errors.push("read another quote");
    } else if (r.res.status === 404) stale++;
    else errors.push(`read ${r.res.status}`);
  }
  return {
    probe: "read-after-write",
    // Fails on any stale or wrong read. Refused writes only fail it when
    // fewer than three quarters of the pairs could be checked at all.
    outcome: ok === pairs - writeFailures && ok >= Math.ceil(pairs * 0.75) ? "pass" : "fail",
    pairs,
    ok,
    stale,
    writeFailures,
    errors: errors.slice(0, 10),
    write: summarize(writeMs),
    read: summarize(readMs),
  };
}

export interface NeonTarget {
  apiKey: string;
  project: string;
  branchId: string;
  endpointId: string;
}

async function neon<T>(o: ProbeOptions, t: NeonTarget, path: string, init: RequestInit = {}) {
  const res = await o.fetch(`https://console.neon.tech/api/v2/projects/${t.project}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t.apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Neon ${init.method ?? "GET"} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Refuses unless the endpoint is the staging branch's and that branch is not the default. */
export async function assertStagingEndpoint(o: ProbeOptions, t: NeonTarget): Promise<void> {
  const { branch } = await neon<{ branch: { name: string; default?: boolean; primary?: boolean } }>(
    o,
    t,
    `/branches/${t.branchId}`,
  );
  if (branch.name !== "staging" || branch.default || branch.primary) {
    throw new Error("refused: the branch is not the staging branch");
  }
  const { endpoint } = await neon<{ endpoint: { branch_id: string } }>(
    o,
    t,
    `/endpoints/${t.endpointId}`,
  );
  if (endpoint.branch_id !== t.branchId) {
    throw new Error("refused: the compute is not on the staging branch");
  }
}

export async function restart(o: ProbeOptions, t: NeonTarget, windowMs = 180_000) {
  await assertStagingEndpoint(o, t);
  // A read before the restart, through whatever connection the Worker holds.
  const before = await timed(o, tripsUrl(o), { headers: headers(o) });
  const started = o.now();
  await neon(o, t, `/endpoints/${t.endpointId}/restart`, { method: "POST" });
  const statuses = new Map<string, number>();
  let firstFailureMs: number | null = null;
  let recoveredMs: number | null = null;
  let sawFailure = false;
  while (o.now() - started < windowMs) {
    let status: string;
    try {
      const r = await timed(o, tripsUrl(o), { headers: headers(o) });
      status = String(r.res.status);
    } catch {
      status = "network";
    }
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    const at = Math.round(o.now() - started);
    if (status !== "200") {
      sawFailure = true;
      firstFailureMs ??= at;
    } else if (sawFailure || at > 20_000) {
      // Answers again after a failure, or never failed for 20 seconds.
      recoveredMs = at;
      break;
    }
    await o.sleep(1_000);
  }
  const after = recoveredMs === null ? null : await readAfterWrite(o, 8);
  return {
    probe: "restart",
    outcome: recoveredMs !== null && after?.outcome === "pass" ? "pass" : "fail",
    // False when no read failed: the restart was too quick to see from here.
    sawFailure,
    beforeStatus: before.res.status,
    statuses: Object.fromEntries(statuses),
    firstFailureMs,
    recoveredMs,
    readAfterWrite: after,
  };
}

/** Reads and checks the environment. Exported for the unit test. */
export function optionsFromEnv(env: NodeJS.ProcessEnv): { api: string; origin: string } {
  let api: URL;
  let origin: URL;
  try {
    api = new URL(env.PROBE_API ?? "");
    origin = new URL(env.PROBE_ORIGIN ?? "");
  } catch {
    throw new Error("PROBE_API and PROBE_ORIGIN must be https URLs");
  }
  if (api.protocol !== "https:" || !/^api-staging\./.test(api.hostname)) {
    throw new Error("PROBE_API must be the staging API (https://api-staging.<domain>)");
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new Error("PROBE_ORIGIN is an https origin: scheme and host only");
  }
  return { api: api.origin, origin: origin.origin };
}

export function neonFromEnv(env: NodeJS.ProcessEnv): NeonTarget {
  for (const name of [
    "NEON_API_KEY",
    "NEON_PROJECT_ID",
    "STAGING_BRANCH_ID",
    "STAGING_ENDPOINT_ID",
  ]) {
    if (!env[name]) throw new Error(`${name} is required for restart`);
  }
  return {
    apiKey: env.NEON_API_KEY as string,
    project: env.NEON_PROJECT_ID as string,
    branchId: env.STAGING_BRANCH_ID as string,
    endpointId: env.STAGING_ENDPOINT_ID as string,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const which = process.argv.slice(2).filter((a) => a !== "--");
  const base = optionsFromEnv(process.env);
  const o: ProbeOptions = {
    ...base,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  let failed = false;
  for (const name of which.length ? which : ["latency", "raw"]) {
    let result: { outcome: string };
    try {
      if (name === "latency") result = await latency(o);
      else if (name === "raw") result = await readAfterWrite(o);
      else if (name === "restart") result = await restart(o, neonFromEnv(process.env));
      else throw new Error(`unknown probe ${name}; use latency, raw, or restart`);
    } catch (err) {
      result = { outcome: "fail", probe: name, error: (err as Error).message } as {
        outcome: string;
      };
    }
    console.log(JSON.stringify(result));
    if (result.outcome !== "pass") failed = true;
  }
  if (failed) process.exitCode = 1;
}
