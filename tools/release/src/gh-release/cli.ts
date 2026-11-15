/**
 * gh-release: the commands release.yml runs. Not for laptops (nov1 is).
 *
 *   pnpm --silent --filter @tidegrid/release gh-release schema-check [--tree-last 0052_name.sql]
 *   pnpm --silent --filter @tidegrid/release gh-release release --worker api --sha <full> \
 *     --build-id <short> --traffic all-at-once|ten-percent-first --soak <seconds> --ledger <file> \
 *     [--tree <checkout of the commit>]
 *   pnpm --silent --filter @tidegrid/release gh-release rollback --worker api --to previous|<version id> --ledger <file>
 *
 * Exit codes: 0 done, 1 a check failed after acting, 2 usage, 3 refused
 * (nothing changed).
 */
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Args, flag, onlyFlags, parseArgs } from "../args.ts";
import { Refusal } from "../core.ts";
import { redact } from "../redact.ts";
import { type GhDeps, GhFailure, GhRefusal, say } from "./deps.ts";
import {
  type GhWorker,
  ghWorkers,
  releaseWorker,
  rollbackWorker,
  schemaReady,
  type Traffic,
  treeLastMigration,
} from "./release.ts";

function worker(args: Args): GhWorker {
  const w = flag(args, "worker");
  if (!ghWorkers.includes(w as GhWorker)) throw new GhRefusal("--worker is api, console, or guest");
  return w as GhWorker;
}

function required(args: Args, name: string): string {
  const v = flag(args, name);
  if (!v) throw new GhRefusal(`--${name} is required`);
  return v;
}

export async function ghMain(argv: readonly string[], deps: GhDeps): Promise<number> {
  const [name, ...rest] = argv;
  try {
    const args = parseArgs(rest);
    if (name === "schema-check") {
      // --tree-last: the gate names another commit's last migration file.
      onlyFlags(args, ["tree-last"]);
      const named = flag(args, "tree-last");
      if (named !== undefined && !/^\d{4}_[A-Za-z0-9_]+\.sql$/.test(named)) {
        throw new GhRefusal("--tree-last is a migration file name");
      }
      const files = readdirSync(join(deps.repoRoot, "packages/database/migrations"));
      await schemaReady(deps, named ?? treeLastMigration(files));
      return 0;
    }
    if (name === "release") {
      onlyFlags(args, ["worker", "sha", "build-id", "traffic", "soak", "ledger", "tree"]);
      const traffic = required(args, "traffic");
      if (traffic !== "all-at-once" && traffic !== "ten-percent-first") {
        throw new GhRefusal("--traffic is all-at-once or ten-percent-first");
      }
      const soak = Number(flag(args, "soak") ?? "600");
      if (!Number.isInteger(soak) || soak < 0 || soak > 3600) {
        throw new GhRefusal("--soak is whole seconds from 0 to 3600");
      }
      // --tree: the checkout of the commit being released. The tooling runs
      // from main's checkout, so a release always uses today's checks.
      const tree = flag(args, "tree");
      const target = tree ? { ...deps, repoRoot: resolve(tree) } : deps;
      await releaseWorker(target, {
        worker: worker(args),
        sha: required(args, "sha"),
        buildId: required(args, "build-id"),
        traffic: traffic as Traffic,
        soakSeconds: soak,
        ledgerPath: required(args, "ledger"),
      });
      return 0;
    }
    if (name === "rollback") {
      onlyFlags(args, ["worker", "to", "ledger"]);
      await rollbackWorker(deps, worker(args), required(args, "to"), required(args, "ledger"));
      return 0;
    }
    say(deps, "gh-release schema-check | release ... | rollback ...  (see src/gh-release/cli.ts)");
    return 2;
  } catch (err) {
    if (err instanceof GhRefusal || err instanceof Refusal) {
      say(deps, `REFUSED: ${err.message}`);
      return 3;
    }
    if (err instanceof GhFailure) {
      say(deps, `FAILED: ${err.message}`);
      return 1;
    }
    say(deps, `ERROR: ${redact((err as Error).message ?? String(err))}`);
    return 1;
  }
}

function realDeps(): GhDeps {
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
  let n = 0;
  return {
    exec: (cmd, args, { cwd, env }) =>
      new Promise((done, fail) => {
        // stdout is captured for the few JSON listings; stderr is the job log.
        // Each command has a deadline, so a hung wrangler call fails in time
        // for the rollback to run well inside the job's own time limit. The
        // child leads its own process group, and the whole group is killed.
        const child = spawn(cmd, [...args], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "inherit"],
          detached: true,
        });
        const limitMs = cmd === "pnpm" && args[1] === "wrangler" ? 5 * 60_000 : 10 * 60_000;
        const timer = setTimeout(() => {
          console.log(
            `ERROR: ${cmd} ${args.slice(0, 3).join(" ")} ran past ${limitMs / 60_000} minutes; stopped`,
          );
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, limitMs);
        let stdout = "";
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          fail(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done({ code: code ?? 124, stdout });
        });
      }),
    fetch: (input, init) => globalThis.fetch(input, init),
    env: process.env,
    print: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    repoRoot,
    readFile: (p) => readFileSync(p, "utf8"),
    appendFile: (p, t) => appendFileSync(p, t),
    tempPath: (name) => join(process.env.RUNNER_TEMP ?? tmpdir(), `${process.pid}-${n++}-${name}`),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await ghMain(process.argv.slice(2), realDeps());
}
