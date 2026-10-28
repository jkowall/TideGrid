/**
 * nov1 db <status|backup|migrate|seed|outbox-summary|platform> (P2, P7, P8).
 *
 * The admin URL comes from --url-env (default NEON_DATABASE_URL) and is mapped
 * to DATABASE_URL in the child only, never exported and never printed. The
 * command refuses in a shell that carries any name that would rotate
 * tidegrid_app or seed local hostnames (invariant 8). Never `app-role:password`
 * or `test:integration` against main: no subcommand here can run them.
 */
import { type Args, flag, has, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, type Plan, printPlan, Refusal } from "../core.ts";
import { assertNoDbHazard, childEnv, present } from "../env.ts";
import { classifyUrl, displayHost, liveGate } from "../gate.ts";
import { git, releaseState } from "../git.ts";
import { lastDone, loadJournal, record } from "../journal.ts";
import { isCutoverConfig } from "../phase.ts";
import { assertArgvSafe } from "../redact.ts";
import { treeMigrations } from "./preflight.ts";

export const dbSubcommands = [
  "status",
  "backup",
  "migrate",
  "seed",
  "outbox-summary",
  "platform",
] as const;
type Sub = (typeof dbSubcommands)[number];

export const platformHostname = "demo.tidegrid.us";
const seedNames = ["SEED_OWNER_EMAILS", "SEED_SINGLE_TENANT_OWNER", "SEED_OWNER_DISPLAY_NAME"];

/** The platform row and its audit event, in the shape the lifecycle functions write (0011:37-45). */
export const platformSql = {
  existing: "select tenant_id::text, kind, status from public.tenant_hostnames where hostname = $1",
  tenant: "select id::text from public.tenants where slug = $1",
  context:
    "select set_config('app.tenant_id', $1, true), set_config('app.actor_type', 'support', true), set_config('app.actor_id', 'nov1:A10', true)",
  insert:
    "insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at) values ($1, $2::uuid, 'platform', 'active', now())",
  audit:
    "insert into public.audit_events (tenant_id, action, subject_type, subject_id, reason, after_state) values ($1::uuid, 'hostname.platform_added', 'tenant_hostname', $2, 'Platform hostname for the demo cutover (Nov 1 runbook P8, gate A10)', jsonb_build_object('status', 'active', 'kind', 'platform'))",
};

export const outboxSql =
  "select state, coalesce(last_error_code, '-') as code, count(*)::int as n from public.email_messages group by 1, 2 order by 1, 2";

function dbPlan(sub: Sub, urlEnv: string, slug?: string): Plan {
  const child = `DATABASE_URL=<$${urlEnv}, child only>`;
  const steps: Record<Sub, Plan["steps"]> = {
    status: [
      {
        id: "P2.1",
        title: "Which migrations Neon main has",
        gate: "A1",
        commands: [`${child} pnpm --filter @tidegrid/database migrate:status`],
        envNames: [urlEnv],
        expect: [
          "0001 and 0002 applied, the rest of the tree pending; stop if anything else is applied",
        ],
        rollback: ["not applicable (read-only)"],
      },
    ],
    backup: [
      {
        id: "P2.2",
        title: "Restore point: a branch of main with no compute and no expiry",
        gate: "A1",
        commands: [
          "pnpm --filter @tidegrid/database neon:branch create pre-nov1-<sha7> --no-expiry --no-endpoint",
        ],
        envNames: ["NEON_API_KEY", "NEON_PROJECT_ID"],
        expect: ['{"branchId": ...} only; no URI exists without an endpoint, so none is printed'],
        verify: [
          "the branch is listed in the Neon console with no compute; record the UTC time for point-in-time restore",
        ],
        rollback: ["deleting the branch later takes its own owner approval"],
      },
    ],
    migrate: [
      {
        id: "P2.3",
        title: "Apply the tree's pending migrations to main",
        gate: "A1",
        commands: [`${child} pnpm --filter @tidegrid/database migrate`],
        envNames: [
          urlEnv,
          "TIDEGRID_MIGRATE_LOCK_TIMEOUT_MS",
          "TIDEGRID_MIGRATE_STATEMENT_TIMEOUT_MS",
        ],
        expect: [
          "each file in its own transaction under the advisory lock, lock_timeout 5000 ms, statement_timeout 120000 ms; role assertions pass",
        ],
        verify: ["nov1 db status reports every file applied"],
        rollback: [
          "no down migrations. A timeout rolls back that file only; main stays at an intermediate version. Do not release the API until a forward fix lands, or restore from P2.2 (its own approval)",
        ],
        cannotRestore: ["data written after the restore point, if main is restored"],
      },
    ],
    seed: [
      {
        id: "P2.4",
        title: "Seed the synthetic operators (idempotent)",
        gate: "A1",
        commands: [`${child} pnpm --filter @tidegrid/seed seed`],
        envNames: [urlEnv, ...seedNames],
        expect: ["created and unchanged counts; preview hostnames active and verified"],
        verify: ["a second run changes nothing"],
        rollback: ["none needed: synthetic. Memberships are never removed (seed.ts)"],
      },
    ],
    "outbox-summary": [
      {
        id: "P7",
        title: "Email outbox by state and failure code (read-only)",
        gate: "A1",
        commands: [
          `select ... from public.email_messages group by state, last_error_code (via $${urlEnv})`,
        ],
        envNames: [urlEnv],
        expect: ["at P7 switch-on, the P6 backlog ends failed with recipient_not_allowed"],
        rollback: ["not applicable (read-only)"],
      },
    ],
    platform: [
      {
        id: "P8.1",
        title: `Platform row ${platformHostname} for ${slug ?? "<slug>"}`,
        gate: "A10",
        commands: [platformSql.context, platformSql.insert, platformSql.audit],
        envNames: [urlEnv],
        expect: ["one active platform row and its audit event, in one transaction"],
        rollback: [
          "none: keep it active. Its tenant and kind are immutable, and disabling it is permanent (0011:91-94)",
        ],
        cannotRestore: ["the row: it can never move to another tenant"],
      },
    ],
  };
  return {
    command: `db ${sub}`,
    target: `the database in $${urlEnv}`,
    notes: [
      "Refuses with TIDEGRID_EPHEMERAL_DB, TIDEGRID_APP_PASSWORD, SEED_LOCAL_HOSTNAMES, E2E_ADMIN_DATABASE_URL, or SEED_DEMO_BOOKINGS (unless --d14 b) in the shell.",
    ],
    steps: steps[sub],
  };
}

function urlFrom(deps: Deps, urlEnv: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(urlEnv)) throw new Refusal("--url-env takes a variable name");
  const url = deps.env[urlEnv];
  if (!url) throw new Refusal(`${urlEnv} is not set in this shell`);
  return url;
}

async function child(
  deps: Deps,
  args: string[],
  extra: Record<string, string>,
  stdio: "inherit" | "pipe",
) {
  assertArgvSafe("pnpm", args);
  return deps.exec("pnpm", args, { cwd: deps.repoRoot, env: childEnv(deps, extra), stdio });
}

export async function db(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["url-env", "live", "go", "d14"]);
  const sub = args.positional[0] as Sub;
  if (!(dbSubcommands as readonly string[]).includes(sub)) {
    throw new Refusal(`nov1 db ${dbSubcommands.join("|")}`);
  }
  const urlEnv = flag(args, "url-env") ?? "NEON_DATABASE_URL";
  const slug = args.positional[1];
  const d14 = flag(args, "d14") ?? "a";
  if (d14 !== "a" && d14 !== "b") throw new Refusal("--d14 is a or b");
  assertNoDbHazard(deps, { allowDemoBookings: d14 === "b" });
  if (sub === "backup") {
    if (!has(args, "live")) {
      printPlan(deps, dbPlan(sub, urlEnv));
      return 0;
    }
    return backup(deps, args);
  }
  const url = urlFrom(deps, urlEnv);
  const live = classifyUrl(url) === "live";
  if (live && !has(args, "live")) {
    printPlan(deps, dbPlan(sub, urlEnv, slug));
    return 0;
  }
  if (live && present(deps.env, "DATABASE_URL")) {
    throw new Refusal(
      "DATABASE_URL is exported in this shell; unset it. nov1 maps --url-env into the child only.",
    );
  }
  const host = displayHost(url);
  if (live) {
    await liveGate(
      deps,
      { live: true, go: flag(args, "go") },
      {
        gates: sub === "platform" ? ["A10"] : ["A1"],
        confirm: sub === "platform" ? [host, slug ?? "", platformHostname] : [host],
        action: `${sub} on ${host}`,
        readOnly: sub === "status" || sub === "outbox-summary",
      },
    );
  }
  const env = { DATABASE_URL: url };
  switch (sub) {
    case "status": {
      const r = await child(
        deps,
        ["--filter", "@tidegrid/database", "migrate:status"],
        env,
        "pipe",
      );
      if (r.code !== 0) throw new Failure("migrate:status failed");
      const rows = r.stdout
        .split("\n")
        .map((l) => /^(applied|pending)\s+(\S+\.sql)$/.exec(l.trim()))
        .filter(Boolean) as RegExpExecArray[];
      for (const m of rows) out(deps, `${m[1]}  ${m[2]}`);
      const applied = rows.filter((m) => m[1] === "applied").map((m) => m[2]);
      const tree = treeMigrations(deps.repoRoot);
      out(
        deps,
        `applied ${applied.length} of ${tree.length}; last applied ${applied.at(-1) ?? "none"}; tree last ${tree.at(-1)}`,
      );
      if (live)
        record(deps, {
          phase: "p2",
          step: "db-status",
          result: "done",
          note: `applied ${applied.length}/${tree.length}, last ${applied.at(-1) ?? "none"}`,
        });
      return 0;
    }
    case "migrate": {
      const r = await child(
        deps,
        ["--filter", "@tidegrid/database", "migrate"],
        {
          ...env,
          ...pass(deps, [
            "TIDEGRID_MIGRATE_LOCK_TIMEOUT_MS",
            "TIDEGRID_MIGRATE_STATEMENT_TIMEOUT_MS",
          ]),
        },
        "inherit",
      );
      if (live)
        record(deps, { phase: "p2", step: "db-migrate", result: r.code === 0 ? "done" : "failed" });
      if (r.code !== 0)
        throw new Failure(
          "migrate failed: main may be at an intermediate version; do not release the API",
        );
      return 0;
    }
    case "seed": {
      const r = await child(
        deps,
        ["--filter", "@tidegrid/seed", "seed"],
        {
          ...env,
          ...pass(deps, [...seedNames, ...(d14 === "b" ? ["SEED_DEMO_BOOKINGS"] : [])]),
        },
        "inherit",
      );
      if (live)
        record(deps, { phase: "p2", step: "db-seed", result: r.code === 0 ? "done" : "failed" });
      if (r.code !== 0) throw new Failure("seed failed");
      return 0;
    }
    case "outbox-summary": {
      const sql = deps.sql(url);
      try {
        for (const row of await sql.query<{ state: string; code: string; n: number }>(outboxSql)) {
          out(deps, `${row.state.padEnd(9)} ${row.code.padEnd(28)} ${row.n}`);
        }
      } finally {
        await sql.end();
      }
      return 0;
    }
    case "platform":
      return platform(deps, url, slug, live);
    default:
      throw new Refusal("unknown db subcommand");
  }
}

function pass(deps: Deps, names: readonly string[]): Record<string, string> {
  const r: Record<string, string> = {};
  for (const n of names) if (present(deps.env, n)) r[n] = deps.env[n] as string;
  return r;
}

async function backup(deps: Deps, args: Args): Promise<number> {
  for (const n of ["NEON_API_KEY", "NEON_PROJECT_ID"]) {
    if (!present(deps.env, n)) throw new Refusal(`${n} is not set in this shell`);
  }
  const sha7 = (await git(deps, ["rev-parse", "--short=7", "HEAD"])).trim();
  const name = `pre-nov1-${sha7}`;
  await liveGate(
    deps,
    { live: true, go: flag(args, "go") },
    {
      gates: ["A1"],
      confirm: [name],
      action: `create Neon branch ${name} from main, no compute, no expiry`,
    },
  );
  const journal = loadJournal(deps);
  if (lastDone(journal, "db-backup")) {
    out(deps, "a backup branch is already recorded; nothing to do");
    return 0;
  }
  const r = await child(
    deps,
    [
      "--filter",
      "@tidegrid/database",
      "neon:branch",
      "create",
      name,
      "--no-expiry",
      "--no-endpoint",
    ],
    pass(deps, ["NEON_API_KEY", "NEON_PROJECT_ID"]),
    "pipe",
  );
  const id = /"branchId":"([a-z0-9-]+)"/.exec(r.stdout)?.[1];
  record(deps, {
    phase: "p2",
    step: "db-backup",
    gate: "A1",
    result: r.code === 0 && id ? "done" : "failed",
    note: `${name} ${id ?? "no id"} at ${deps.now().toISOString()} (UTC, the point-in-time restore anchor)`,
  });
  if (r.code !== 0 || !id) throw new Failure("backup branch create failed");
  out(deps, `backup branch ${name}: ${id}, ${deps.now().toISOString()}`);
  return 0;
}

async function platform(
  deps: Deps,
  url: string,
  slug: string | undefined,
  live: boolean,
): Promise<number> {
  if (slug !== "demo-harbor" && slug !== "demo-reef")
    throw new Refusal("name the tenant slug: demo-harbor or demo-reef");
  if (live) {
    const journal = loadJournal(deps);
    if (!lastDone(journal, "last-seat"))
      throw new Refusal(
        "the journal does not show step 6 (last-seat) passed; P8 runs after acceptance",
      );
    // Bound to the C4 merge itself: the tree must carry the cutover config,
    // and HEAD (that tree) must be approved under A10. A C7 approval alone
    // never unlocks the permanent platform row.
    if (!isCutoverConfig(deps.configs())) {
      throw new Refusal(
        "this tree does not carry the C4 cutover config (demo.tidegrid.us route, workers_dev off); merge C4 first",
      );
    }
    const state = await releaseState(deps, journal);
    if (!journal.approved.some((a) => a.gate === "A10" && a.sha === state.head)) {
      throw new Refusal(
        "HEAD, the tree that carries C4, is not approved under A10 (nov1 approve-sha <C4 merge> --go A10)",
      );
    }
  }
  const sql = deps.sql(url);
  try {
    const result = await sql.transaction(async (tx) => {
      const [existing] = await tx.query<{ tenant_id: string; kind: string; status: string }>(
        platformSql.existing,
        [platformHostname],
      );
      const [tenant] = await tx.query<{ id: string }>(platformSql.tenant, [slug]);
      if (!tenant) throw new Failure(`no tenant ${slug}`);
      if (existing) {
        if (
          existing.tenant_id === tenant.id &&
          existing.kind === "platform" &&
          existing.status === "active"
        )
          return "unchanged";
        throw new Refusal(
          `${platformHostname} already exists as ${existing.kind} ${existing.status} for another row; nothing written`,
        );
      }
      await tx.query(platformSql.context, [tenant.id]);
      await tx.query(platformSql.insert, [platformHostname, tenant.id]);
      await tx.query(platformSql.audit, [tenant.id, platformHostname]);
      return "created";
    });
    out(deps, `${platformHostname} -> ${slug}: ${result}`);
    if (live)
      record(deps, {
        phase: "p8",
        step: "db-platform",
        gate: "A10",
        result: "done",
        note: `${slug} ${result}`,
      });
    return 0;
  } finally {
    await sql.end();
  }
}
