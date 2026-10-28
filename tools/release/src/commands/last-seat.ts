/**
 * nov1 last-seat (P6 step 6): the last seat and the whole boat, raced through
 * the deployed public API.
 *
 * Demo Reef, shared seats (Two-Tank Morning Dive: seat limit 12, party up to 6,
 * catalog.ts:128-135), on a departure nobody has touched:
 *   1. two fillers of 6 and 5 seats, each quoted, checked out, and PAID, so
 *      one seat is left. Paid, not left open: one client address may hold at
 *      most 3 open checkouts per operator (domain-booking checkout.ts:46), and
 *      open fillers would turn the racers into too_many_checkouts 429s.
 *   2. eight one-seat quotes, after the fill and before the race, because
 *      quote creation itself refuses insufficient_capacity (pricing-public.ts:27).
 *   3. eight checkouts at once: exactly 1 opens, 7 answer 409
 *      insufficient_capacity.
 *   4. pay the winner; the trip then drops out of the one-seat listing.
 * Demo Harbor, whole boat (Private Half-Day Charter), on its own tenant budget:
 * 8 quotes, 8 racing checkouts, 1 pay.
 *
 * From one address the checkout's per-client advisory lock (checkout.ts:177)
 * serializes the racers, so this proves no oversell through the deployed
 * stack, not concurrent hold acquisition; the database race suites prove that.
 * The first 429 stops the run and is reported as rate-limited, never as an
 * oversell or a failure.
 */
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, type Plan, printPlan } from "../core.ts";
import { displayHost, liveGate } from "../gate.ts";
import {
  type Call,
  type CallLog,
  checkout,
  client,
  errorCode,
  findTrips,
  newCallLog,
  type Profile,
  parseHosts,
  payFake,
  profileFor,
  quote,
  RateLimited,
  type Trip,
} from "../http.ts";
import { record } from "../journal.ts";

export const publicLimitPerMinute = 30;
export const racers = 8;

export interface RacePlan {
  tenant: string;
  product: string;
  kind: "shared_seat" | "private_charter";
  /** Earliest departure, in days from today, clear of the change cutoff. */
  fromDays: number;
  weekdays?: number[];
  fillers: number[];
  racerParty: number;
  /** Every limited public command, in order. */
  calls: string[];
}

function buildCalls(fillers: number[], n: number): string[] {
  const calls: string[] = [];
  for (const f of fillers) calls.push(`quote ${f}`, `checkout ${f}`, `pay ${f}`);
  for (let i = 0; i < n; i++) calls.push("quote 1");
  for (let i = 0; i < n; i++) calls.push("checkout race");
  calls.push("pay winner");
  return calls;
}

export const racePlans: RacePlan[] = [
  {
    tenant: "demo-reef",
    product: "Two-Tank Morning Dive",
    kind: "shared_seat",
    fromDays: 4,
    fillers: [6, 5],
    racerParty: 1,
    calls: buildCalls([6, 5], racers),
  },
  {
    tenant: "demo-harbor",
    product: "Private Half-Day Charter",
    kind: "private_charter",
    fromDays: 9,
    weekdays: [6, 7],
    fillers: [],
    racerParty: 2,
    calls: buildCalls([], racers),
  },
];

/** Limited calls per tenant. A unit test pins each at or under the limit. */
export function budget(plans: readonly RacePlan[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of plans) m.set(p.tenant, (m.get(p.tenant) ?? 0) + p.calls.length);
  return m;
}

export function lastSeatPlan(profile: Profile): Plan {
  return {
    command: `last-seat --profile ${profile.name}`,
    target: profile.apiBase,
    notes: [
      `Limited calls per tenant: ${[...budget(racePlans)].map(([t, n]) => `${t} ${n}`).join(", ")}; the limit is ${publicLimitPerMinute} per 60 s per address per tenant.`,
      "Writes permanent synthetic rows (no DELETE in the runtime). Picks a fresh departure every run.",
      "Every booker is a synthetic .test address.",
    ],
    steps: racePlans.map((p, i) => ({
      id: `${i + 1}`,
      title: `${p.tenant}: ${p.kind === "shared_seat" ? "last seat" : "whole boat"} on ${p.product}`,
      gate: profile.name === "preview" ? "A5" : undefined,
      commands: p.calls.map(
        (c) =>
          `POST ${c.startsWith("pay") ? "/v1/fake-provider/payments/<ref>/succeed" : c.startsWith("quote") ? "/v1/public/quotes" : "/v1/public/checkout-sessions"} (${c})`,
      ),
      expect: [
        `exactly 1 of ${racers} racing checkouts opens; ${racers - 1} answer 409 insufficient_capacity`,
        "after paying the winner the trip is gone from the listing for its racer party",
      ],
      rollback: ["none: synthetic rows stay; unpaid holds expire in 15 minutes"],
    })),
  };
}

export type RaceOutcome = "pass" | "oversell" | "fail" | "rate-limited";

export interface RaceResult {
  tenant: string;
  outcome: RaceOutcome;
  detail: string;
  statuses: Record<string, number>;
  winner?: string;
}

async function race(deps: Deps, call: Call, p: RacePlan): Promise<RaceResult> {
  const statuses: Record<string, number> = {};
  const tally = (key: string) => {
    statuses[key] = (statuses[key] ?? 0) + 1;
  };
  const trips = await findTrips(deps, call, {
    product: p.product,
    party: Math.max(...p.fillers, p.racerParty),
    fromDays: p.fromDays,
    ...(p.weekdays ? { weekdays: p.weekdays } : {}),
  });
  const fresh = trips.find((t) => t.capacity.remaining === t.capacity.total);
  if (!fresh)
    return { tenant: p.tenant, outcome: "fail", detail: "no untouched departure found", statuses };
  out(
    deps,
    `${p.tenant}: departure ${fresh.localDate} (${fresh.capacity.total} ${p.kind === "shared_seat" ? "seats" : "aboard"})`,
  );

  for (const size of p.fillers) {
    const q = await quote(call, fresh, size);
    if (q.status !== 201)
      return {
        tenant: p.tenant,
        outcome: "fail",
        detail: `filler quote ${q.status} ${errorCode(q)}`,
        statuses,
      };
    const { answer, open } = await checkout(call, q, `${p.tenant}-filler`);
    if (!open)
      return {
        tenant: p.tenant,
        outcome: "fail",
        detail: `filler checkout ${answer.status} ${errorCode(answer)}`,
        statuses,
      };
    const paid = await payFake(call, open);
    if (paid.status !== 200)
      return { tenant: p.tenant, outcome: "fail", detail: `filler pay ${paid.status}`, statuses };
  }

  const quotes = [];
  for (let i = 0; i < racers; i++) {
    const q = await quote(call, fresh, p.racerParty);
    if (q.status !== 201)
      return {
        tenant: p.tenant,
        outcome: "fail",
        detail: `racer quote ${q.status} ${errorCode(q)}`,
        statuses,
      };
    quotes.push(q);
  }
  const answers = await Promise.all(
    quotes.map((q, i) => checkout(call, q, `${p.tenant}-racer${i + 1}`)),
  );
  for (const a of answers) tally(`${a.answer.status} ${errorCode(a.answer) ?? "opened"}`);
  const winners = answers.filter((a) => a.open);
  const capacityLosers = answers.filter(
    (a) => a.answer.status === 409 && errorCode(a.answer) === "insufficient_capacity",
  );
  if (winners.length > 1) {
    return {
      tenant: p.tenant,
      outcome: "oversell",
      detail: `${winners.length} checkouts opened for the last unit`,
      statuses,
    };
  }
  const winner = winners[0]?.open;
  if (!winner || capacityLosers.length !== racers - 1) {
    return {
      tenant: p.tenant,
      outcome: "fail",
      detail: `${winners.length} opened, ${capacityLosers.length} capacity 409s`,
      statuses,
    };
  }
  const paid = await payFake(call, winner);
  if (paid.status !== 200)
    return { tenant: p.tenant, outcome: "fail", detail: `winner pay ${paid.status}`, statuses };
  const after = await findTrips(deps, call, {
    product: p.product,
    party: p.racerParty,
    fromDays: p.fromDays,
    ...(p.weekdays ? { weekdays: p.weekdays } : {}),
  });
  const still = after.find((t: Trip) => t.tripId === fresh.tripId);
  if (still)
    return {
      tenant: p.tenant,
      outcome: "fail",
      detail: `still listed with ${still.capacity.remaining} left`,
      statuses,
    };
  return {
    tenant: p.tenant,
    outcome: "pass",
    detail: "1 winner, 7 capacity 409s, nothing left",
    statuses,
    winner: winner.sessionId,
  };
}

export async function runLastSeat(
  deps: Deps,
  profile: Profile,
  log: CallLog = newCallLog(),
): Promise<RaceResult[]> {
  const results: RaceResult[] = [];
  for (const p of racePlans) {
    const host = profile.hosts.find((h) => h.slug === p.tenant);
    if (!host) {
      results.push({
        tenant: p.tenant,
        outcome: "fail",
        detail: "no host given for this tenant",
        statuses: {},
      });
      continue;
    }
    try {
      results.push(await race(deps, client(deps, profile, host, log), p));
    } catch (err) {
      if (!(err instanceof RateLimited)) throw err;
      results.push({
        tenant: p.tenant,
        outcome: "rate-limited",
        detail: err.message,
        statuses: {},
      });
      break;
    }
  }
  return results;
}

export async function lastSeat(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["profile", "api", "base", "hosts", "live", "go", "dry-run"]);
  const hosts = parseHosts(flag(args, "hosts"));
  const profile = profileFor(flag(args, "profile"), flag(args, "api") ?? flag(args, "base"), hosts);
  if (args.flags.has("dry-run") || (profile.name === "preview" && !args.flags.has("live"))) {
    printPlan(deps, lastSeatPlan(profile));
    return 0;
  }
  if (profile.name === "preview") {
    await liveGate(
      deps,
      { live: true, go: flag(args, "go") },
      {
        gates: ["A5"],
        confirm: [displayHost(profile.apiBase)],
        action: "race synthetic checkouts on the preview (permanent synthetic rows)",
      },
    );
  }
  const log = newCallLog();
  const results = await runLastSeat(deps, profile, log);
  for (const r of results) {
    out(
      deps,
      JSON.stringify({
        check: "last-seat",
        tenant: r.tenant,
        outcome: r.outcome,
        detail: r.detail,
        statuses: r.statuses,
      }),
    );
  }
  out(deps, `limited calls: ${[...log.limited].map(([t, n]) => `${t} ${n}`).join(", ")}`);
  const pass = results.length === racePlans.length && results.every((r) => r.outcome === "pass");
  if (profile.name === "preview") {
    record(deps, {
      phase: "p6",
      step: "last-seat",
      gate: "A5",
      result: pass ? "done" : "failed",
      note: results.map((r) => `${r.tenant} ${r.outcome}`).join(", "),
    });
  }
  if (!pass)
    throw new Failure(`last-seat: ${results.map((r) => `${r.tenant} ${r.outcome}`).join(", ")}`);
  return 0;
}
