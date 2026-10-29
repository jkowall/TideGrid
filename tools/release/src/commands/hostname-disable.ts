/**
 * nov1 hostname-disable <slug> <hostname> (P10 rollback only, gate A18). The
 * only path to `hostnames disable`, which has no prompt and no environment
 * guard (tools/hostnames/src/commands.ts:65-69,160-168). A disabled name is
 * permanent (0011_custom_hostname_lifecycle.sql:91-94), so this refuses
 * anything but a custom row, and never a preview or platform name.
 */
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, type Plan, printPlan, Refusal } from "../core.ts";
import { assertNoDbHazard, childEnv } from "../env.ts";
import { classifyUrl, displayHost, liveGate } from "../gate.ts";
import { record } from "../journal.ts";
import { cutoverHostnames } from "../phase.ts";
import { assertArgvSafe } from "../redact.ts";

export const protectedHostnames = [...cutoverHostnames];
export const hostnameRowSql =
  "select h.kind, t.slug from public.tenant_hostnames h join public.tenants t on t.id = h.tenant_id where h.hostname = $1";

/** Refuse a name that must never be disabled, before any database call. */
export function assertDisableable(hostname: string): void {
  const h = hostname.toLowerCase();
  if (
    protectedHostnames.includes(h) ||
    h.endsWith(".book.tidegrid.us") ||
    h.endsWith("tidegrid.us")
  ) {
    throw new Refusal(
      `${hostname} is a preview or platform name; disabling it is permanent and never a rollback`,
    );
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/.test(h))
    throw new Refusal("give the exact custom hostname");
}

export function hostnameDisablePlan(slug: string, hostname: string): Plan {
  return {
    command: `hostname-disable ${slug} ${hostname}`,
    target: "the database in $NEON_DATABASE_URL",
    steps: [
      {
        id: "P10.R",
        title: `Disable the throwaway custom hostname ${hostname}`,
        gate: "A18",
        commands: [
          hostnameRowSql,
          `DATABASE_URL=<child only> pnpm --filter @tidegrid/hostnames-cli hostnames disable ${slug} ${hostname} "Nov 1 P10 rollback"`,
        ],
        envNames: ["NEON_DATABASE_URL"],
        expect: ["the row is kind custom for this tenant; it ends disabled"],
        rollback: ["none: disabled is terminal and the name stays reserved"],
        cannotRestore: ["the hostname, ever (packages/database/README.md:164)"],
      },
    ],
  };
}

export async function hostnameDisable(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["url-env", "live", "go"]);
  const [slug, hostname] = args.positional;
  if (!slug || !hostname) throw new Refusal("nov1 hostname-disable <slug> <hostname>");
  assertDisableable(hostname);
  assertNoDbHazard(deps, { allowDemoBookings: false });
  const urlEnv = flag(args, "url-env") ?? "NEON_DATABASE_URL";
  const url = deps.env[urlEnv];
  if (!url) throw new Refusal(`${urlEnv} is not set in this shell`);
  const live = classifyUrl(url) === "live";
  if (!args.flags.has("live")) {
    printPlan(deps, hostnameDisablePlan(slug, hostname));
    return 0;
  }
  if (live) {
    await liveGate(
      deps,
      { live: true, go: flag(args, "go") },
      {
        gates: ["A18"],
        confirm: [displayHost(url), hostname],
        action: `permanently disable the custom hostname ${hostname}`,
      },
    );
  }
  const sql = deps.sql(url);
  let row: { kind: string; slug: string } | undefined;
  try {
    [row] = await sql.query<{ kind: string; slug: string }>(hostnameRowSql, [hostname]);
  } finally {
    await sql.end();
  }
  if (!row) throw new Refusal(`no hostname ${hostname}`);
  if (row.kind !== "custom")
    throw new Refusal(`${hostname} is kind ${row.kind}; only custom rows may be disabled`);
  if (row.slug !== slug) throw new Refusal(`${hostname} belongs to another tenant`);
  const argv = [
    "--filter",
    "@tidegrid/hostnames-cli",
    "hostnames",
    "disable",
    slug,
    hostname,
    "Nov 1 P10 rollback",
  ];
  assertArgvSafe("pnpm", argv);
  const r = await deps.exec("pnpm", argv, {
    cwd: deps.repoRoot,
    env: childEnv(deps, { DATABASE_URL: url }),
    stdio: "inherit",
  });
  if (live)
    record(deps, {
      phase: "p10",
      step: "hostname-disable",
      gate: "A18",
      result: r.code === 0 ? "done" : "failed",
      note: hostname,
    });
  if (r.code !== 0) throw new Failure("hostnames disable failed");
  out(deps, `${hostname} disabled (permanent)`);
  return 0;
}
