/**
 * nov1 isolation (P6 step 7, the public half). With tenant A's Origin, every
 * public read of tenant B's trip, quote, and checkout answers the shared 404,
 * with no B data in the body. The console half is
 * apps/operator-site/e2e/isolation.spec.ts.
 *
 * It spends 3 limited calls on B (a quote, a checkout, and its cancel, so the
 * held seat goes back at once) and none on A.
 */
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, type Plan, printPlan } from "../core.ts";
import { displayHost, liveGate } from "../gate.ts";
import {
  type Answer,
  checkout,
  client,
  findTrips,
  newCallLog,
  originOf,
  type Profile,
  parseHosts,
  profileFor,
  quote,
  tenantMetas,
} from "../http.ts";
import { record } from "../journal.ts";

export interface Probe {
  probe: string;
  status: number;
  code: string | null;
  leak: boolean;
}

export function isolationPlan(profile: Profile): Plan {
  return {
    command: `isolation --profile ${profile.name}`,
    target: profile.apiBase,
    notes: ["3 limited calls on tenant B, none on A. Writes one canceled synthetic checkout."],
    steps: [
      {
        id: "1",
        title: "Make tenant B data: a trip id, a quote, an open checkout",
        gate: profile.name === "preview" ? "A5" : undefined,
        commands: [
          "GET /v1/public/trips (B Origin)",
          "POST /v1/public/quotes (B)",
          "POST /v1/public/checkout-sessions (B)",
        ],
        expect: ["201 for the quote and the checkout"],
        rollback: ["step 3 cancels the checkout"],
      },
      {
        id: "2",
        title: "Read B's trip offer, quote, and checkout with A's Origin",
        commands: [
          "GET /v1/public/trips/<B trip>/offer (A Origin)",
          "GET /v1/public/quotes/<B quote> (A Origin)",
          "GET /v1/public/checkout-sessions/<B checkout> with B's secret (A Origin)",
        ],
        expect: ["each answers 404 with no B id, slug, or name in the body"],
        rollback: ["not applicable (reads)"],
      },
      {
        id: "3",
        title: "Cancel B's checkout with B's Origin",
        commands: ["POST /v1/public/checkout-sessions/<B checkout>/cancel (B Origin)"],
        expect: ["200 canceled; the seat goes back at once"],
        rollback: ["not applicable"],
      },
    ],
  };
}

export async function runIsolation(deps: Deps, profile: Profile): Promise<Probe[]> {
  const [a, b] = profile.hosts;
  if (!a || !b || a.slug === b.slug)
    throw new Failure("isolation needs two tenant hosts: A first, then B");
  const log = newCallLog();
  const callA = client(deps, profile, a, log);
  const callB = client(deps, profile, b, log);
  const metaB = tenantMetas(deps.repoRoot).find((t) => t.slug === b.slug);
  const product = b.slug === "demo-reef" ? "Two-Tank Morning Dive" : "Sunset Harbor Cruise";
  const [trip] = await findTrips(deps, callB, { product, party: 1, fromDays: 4 });
  if (!trip) throw new Failure(`no ${product} trip on sale for ${b.slug}`);
  const q = await quote(callB, trip, 1);
  if (q.status !== 201) throw new Failure(`B quote ${q.status}`);
  const { open } = await checkout(callB, q, `${b.slug}-isolation`);
  if (!open) throw new Failure("B checkout did not open");
  const quoteId = (q.json.quote as { quoteId: string }).quoteId;
  const secrets = [
    trip.tripId,
    quoteId,
    open.sessionId,
    b.slug,
    metaB?.name ?? b.slug,
    originOf(profile, b),
  ];
  const probe = (name: string, ans: Answer): Probe => ({
    probe: name,
    status: ans.status,
    code: (ans.json.error as { code?: string } | undefined)?.code ?? null,
    leak: secrets.some((s) => ans.text.includes(s)),
  });
  const probes: Probe[] = [];
  try {
    probes.push(probe("B trip offer", await callA("GET", `/v1/public/trips/${trip.tripId}/offer`)));
    probes.push(probe("B quote", await callA("GET", `/v1/public/quotes/${quoteId}`)));
    probes.push(
      probe(
        "B checkout",
        await callA("GET", `/v1/public/checkout-sessions/${open.sessionId}`, {
          headers: { authorization: `Bearer ${open.secret}` },
        }),
      ),
    );
  } finally {
    await callB("POST", `/v1/public/checkout-sessions/${open.sessionId}/cancel`, {
      limited: true,
      headers: { authorization: `Bearer ${open.secret}` },
    });
  }
  return probes;
}

export async function isolation(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["profile", "api", "base", "hosts", "live", "go", "dry-run"]);
  const profile = profileFor(
    flag(args, "profile"),
    flag(args, "api") ?? flag(args, "base"),
    parseHosts(flag(args, "hosts")),
  );
  if (args.flags.has("dry-run") || (profile.name === "preview" && !args.flags.has("live"))) {
    printPlan(deps, isolationPlan(profile));
    return 0;
  }
  if (profile.name === "preview") {
    await liveGate(
      deps,
      { live: true, go: flag(args, "go") },
      {
        gates: ["A5"],
        confirm: [displayHost(profile.apiBase)],
        action: "probe tenant isolation on the preview (one canceled synthetic checkout)",
      },
    );
  }
  const probes = await runIsolation(deps, profile);
  out(deps, JSON.stringify({ check: "isolation-public", probes }));
  const pass = probes.length === 3 && probes.every((p) => p.status === 404 && !p.leak);
  if (profile.name === "preview")
    record(deps, {
      phase: "p6",
      step: "isolation-public",
      gate: "A5",
      result: pass ? "done" : "failed",
    });
  if (!pass)
    throw new Failure(
      "isolation: a cross-tenant read did not answer the shared 404, or leaked B data",
    );
  return 0;
}
