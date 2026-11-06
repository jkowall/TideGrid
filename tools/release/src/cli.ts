/**
 * nov1: the Nov 1 runbook's commands (docs/runbooks/2026-11-01-preview-deploy.md).
 *
 *   pnpm --filter @tidegrid/release nov1 <command> [options]
 *
 * Dry run is the default for every live target: the command prints the exact
 * commands, the environment variable names, the expected output, and the
 * rollback, and runs nothing. Live needs --live, --go <gate>, a terminal, CI
 * unset, and the target typed back. Exit codes: 0 done, 1 a check failed,
 * 2 usage, 3 refused (nothing changed).
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { type Args, parseArgs } from "./args.ts";
import { accept } from "./commands/accept.ts";
import { approveSha } from "./commands/approve-sha.ts";
import { db } from "./commands/db.ts";
import { evidence } from "./commands/evidence.ts";
import { hostnameDisable } from "./commands/hostname-disable.ts";
import { isolation } from "./commands/isolation.ts";
import { lastSeat } from "./commands/last-seat.ts";
import { paymentAccount } from "./commands/payment-account.ts";
import { preflight } from "./commands/preflight.ts";
import { release } from "./commands/release.ts";
import { secrets } from "./commands/secrets.ts";
import { smoke } from "./commands/smoke.ts";
import { stripeSmoke } from "./commands/stripe-smoke.ts";
import { type Deps, Failure, out, Refusal, type SqlClient } from "./core.ts";
import { DeployedGateRefusal } from "./deployed-gate.ts";
import { parseDeclared } from "./gate.ts";
import { nodeLocalFetch } from "./http.ts";
import { loadConfigs } from "./phase.ts";
import { redact } from "./redact.ts";

export const commands: Record<string, (deps: Deps, args: Args) => Promise<number>> = {
  preflight,
  db,
  secrets,
  release,
  smoke,
  "last-seat": lastSeat,
  isolation,
  accept,
  "stripe-smoke": stripeSmoke,
  "payment-account": paymentAccount,
  "hostname-disable": hostnameDisable,
  "approve-sha": approveSha,
  evidence,
};

export const usage = `nov1 <command> [options]   (dry run unless --live on a live target)

  preflight [--phase pN] [--offline | --network --go A0] [--allow-branch] [--skip-build]
  db status|backup|migrate|seed|outbox-summary [--url-env NEON_DATABASE_URL] [--d14 a|b] --live --go A1
  db platform <slug> [--url-env NAME] --live --go A10
  secrets preview|email|stripe|saas [--list | --put NAME [--from-file <path>] | --generate NAME | --delete NAME] --phase pN --live --go <gate>
  release api|console|guest --phase pN [--rollback [--to <version id>] | --verify] [--kill-switch] [--again] --live --go <gate>
  smoke --profile local|preview --base <api> --hosts h1,h2 [--build <id>] [--live --go A0]
  last-seat --profile local|preview --api <api> --hosts h1,h2 [--live --go A5]
  isolation --profile local|preview --api <api> --hosts A,B [--live --go A5]
  accept guest|console [--grep <title>] [--project phone|desktop] --live --go A5|A10
  stripe-smoke [--tenant <slug>] --live --go A11
  payment-account set <slug> stripe [--url-env NAME] --live --go A12
  hostname-disable <slug> <hostname> [--url-env NAME] --live --go A18
  approve-sha <sha> --go <gate> | --frozen
  evidence [--ci <deployed sha>=<merge sha>,...] [--out <file>.md]

  Any command: --confirm <target>[,<target>...] answers the type-backs from this
  list instead of the keyboard (an unattended run the owner directs; never CI;
  a terminal is still required). Each entry is exactly what would be typed:
  a Worker name, a host, a secret name, a SHA's first 12, or yes:db-at-tree.
  Anything not declared refuses. A rollback stays typed.
  secrets <set> --put NAME --from-file <path>: a Stripe test-mode value from a
  0600 file outside the repository, removed after a done put.
`;

function sqlClient(url: string): SqlClient {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const wrap = (s: postgres.Sql | postgres.TransactionSql): SqlClient => ({
    query: async (text, params = []) =>
      (await s.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as never,
    transaction: (fn) => sql.begin((tx) => fn(wrap(tx))) as never,
    end: () => sql.end({ timeout: 5 }),
  });
  return wrap(sql);
}

export function realDeps(): Deps {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..", "..");
  return {
    exec: (cmd, args, options) =>
      new Promise((done, fail) => {
        if (options.stdin !== undefined && options.stdio === "pipe")
          throw new Error("exec: stdin is for stdio inherit only");
        const child = spawn(cmd, [...args], {
          cwd: options.cwd ?? repoRoot,
          env: options.env as NodeJS.ProcessEnv,
          stdio:
            options.stdio === "pipe"
              ? ["ignore", "pipe", "inherit"]
              : options.stdin === undefined
                ? "inherit"
                : [options.stdin === "null" ? "ignore" : "pipe", "inherit", "inherit"],
        });
        if (options.stdin instanceof Uint8Array) {
          // A child that exits before reading must not crash nov1 with EPIPE.
          child.stdin?.on("error", () => {});
          child.stdin?.end(options.stdin);
        }
        let stdout = "";
        child.stdout?.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        child.on("error", fail);
        child.on("close", (code) => done({ code: code ?? 1, stdout }));
      }),
    fetch: (input, init) => globalThis.fetch(input, init),
    localFetch: nodeLocalFetch,
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    print: (line) => console.log(line),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    repoRoot,
    stateDir:
      process.env.NOV1_STATE_DIR ??
      join(homedir(), ".claude/projects/-Users-jkowall-TideGrid/handoff/nov1"),
    sql: sqlClient,
    nodeVersion: process.versions.node,
    configs: () => loadConfigs(repoRoot),
  };
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help") {
    for (const line of usage.split("\n")) out(deps, line);
    return name ? 0 : 2;
  }
  const command = commands[name];
  if (!command) {
    out(deps, `unknown command ${name}`);
    for (const line of usage.split("\n")) out(deps, line);
    return 2;
  }
  try {
    const args = parseArgs(rest);
    const declared = args.flags.get("confirm");
    if (declared === undefined) return await command(deps, args);
    // Declared confirmations (owner decision 2026-11-05): never in CI, and
    // taken out of the command's own flags so each command needs no change.
    if (deps.env.CI)
      throw new Refusal(
        "CI is set: --confirm is for an unattended run the owner directs, never CI",
      );
    args.flags.delete("confirm");
    const withDeclared: Deps = { ...deps, declared: parseDeclared(String(declared)) };
    const code = await command(withDeclared, args);
    const d = withDeclared.declared as NonNullable<Deps["declared"]>;
    const unused = d.targets.filter((t) => !d.used.has(t));
    if (unused.length) out(deps, `note: declared but not asked: ${unused.join(", ")}`);
    return code;
  } catch (err) {
    if (err instanceof Refusal || err instanceof DeployedGateRefusal) {
      out(deps, `REFUSED: ${err.message}`);
      return 3;
    }
    if (err instanceof Failure) {
      out(deps, `FAILED: ${err.message}`);
      return 1;
    }
    out(deps, `ERROR: ${redact((err as Error).message ?? String(err))}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), realDeps());
}
