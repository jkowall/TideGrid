/**
 * nov1 accept <guest|console> (P6 steps 1, 2, 4, 5, 7; P8's rerun of step 1).
 * The only way to set NOV1_GO for the Playwright deployed modes. Their own
 * globalSetup refuses again under CI, without a terminal, or without NOV1_GO
 * (deployed-gate.ts), and keeps every artifact in NOV1_PRIVATE_DIR.
 */
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, Failure, type Plan, printPlan, Refusal } from "../core.ts";
import { deployedBaseUrl, deployedGates, privateDir } from "../deployed-gate.ts";
import { present } from "../env.ts";
import { liveGate } from "../gate.ts";
import { record } from "../journal.ts";
import { onTerminal } from "../wrangler.ts";

const suites = {
  guest: {
    pkg: "@tidegrid/guest-site",
    names: ["E2E_BASE_URL", "E2E_TENANT", "NOV1_PRIVATE_DIR", "E2E_CHANNEL"],
  },
  console: {
    pkg: "@tidegrid/operator-site",
    names: [
      "E2E_BASE_URL",
      "NOV1_PRIVATE_DIR",
      "E2E_STORAGE_STATE",
      "E2E_OPERATOR",
      "E2E_STAFF_NAME",
      "E2E_FOREIGN_TENANT_ID",
      "E2E_FOREIGN_BOOKING_ID",
      "E2E_FOREIGN_TRIP_ID",
      "E2E_FOREIGN_REFERENCE",
      "E2E_FOREIGN_DATE",
      "E2E_CHANNEL",
    ],
  },
} as const;

export function acceptPlan(suite: keyof typeof suites): Plan {
  const s = suites[suite];
  return {
    command: `accept ${suite}`,
    target: "E2E_BASE_URL",
    notes: [
      "Writes permanent synthetic rows on Neon main. Artifacts stay in NOV1_PRIVATE_DIR; delete them with the storage state after the run.",
    ],
    steps: [
      {
        id: "1",
        title: `Playwright deployed mode for ${s.pkg}`,
        gate: "A5",
        commands: [
          `NOV1_GO=<go> pnpm --filter ${s.pkg} exec playwright test [--grep <title>] (on the terminal)`,
        ],
        envNames: [...s.names],
        expect:
          suite === "guest"
            ? [
                "journey: both brands at 375 and 1280, installability JSON lines",
                "booking: two reference JSON lines, the dive canceled with full_refund",
              ]
            : [
                "staff-booking: calendar, search, day CSV, control totals",
                "isolation: memberships 1, then a 403 or 404 probe table with no tenant B data",
              ],
        rollback: ["none: synthetic rows stay; unpaid holds expire in 15 minutes"],
      },
    ],
  };
}

export async function accept(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["live", "go", "grep", "project"]);
  const suite = args.positional[0];
  if (suite !== "guest" && suite !== "console") throw new Refusal("accept guest or accept console");
  if (!args.flags.has("live")) {
    printPlan(deps, acceptPlan(suite));
    return 0;
  }
  deployedBaseUrl(deps.env.E2E_BASE_URL);
  privateDir({ env: deps.env, repoRoot: deps.repoRoot });
  const go = await liveGate(
    deps,
    { live: true, go: flag(args, "go") },
    {
      gates: deployedGates,
      confirm: [deps.env.E2E_BASE_URL as string],
      action: `drive the deployed ${suite} with Playwright (permanent synthetic rows)`,
    },
  );
  const extraEnv: Record<string, string> = { NOV1_GO: go };
  for (const name of suites[suite].names) {
    if (present(deps.env, name)) extraEnv[name] = deps.env[name] as string;
  }
  const extra: string[] = [];
  const grep = flag(args, "grep");
  const project = flag(args, "project");
  if (grep) extra.push("--grep", grep);
  if (project) extra.push("--project", project);
  const code = await onTerminal(
    deps,
    "pnpm",
    ["--filter", suites[suite].pkg, "exec", "playwright", "test", ...extra],
    { extraEnv },
  );
  record(deps, {
    phase: go === "A10" ? "p8" : "p6",
    step: `accept-${suite}`,
    gate: go,
    result: code === 0 ? "done" : "failed",
  });
  if (code !== 0) throw new Failure(`playwright exited ${code}`);
  return 0;
}
