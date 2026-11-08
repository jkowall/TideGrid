import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { treeMigrations } from "../src/commands/preflight.ts";
import type { Deps, Env, ExecOptions, ExecResult, SqlClient } from "../src/core.ts";
import { type Configs, configPaths, parseJsonc } from "../src/phase.ts";
import { defaultGh } from "./ci-fixtures.ts";

export const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/** What a live health reports when the database is at the tree's last migration. */
export const migratedHealth = { migrations: { latest: treeMigrations(repoRoot).at(-1) } };

/**
 * The api and guest wrangler.jsonc as main had them before any Nov 1 config
 * branch (main 90dd41e), committed as fixtures so no test reads the tree's
 * configs: a merged C1 to C6 must never turn this suite red.
 */
export function fixtureConfigs(): Configs {
  const read = (name: string) =>
    parseJsonc(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as Configs["api"];
  return { api: read("api.wrangler.jsonc"), guest: read("guest.wrangler.jsonc") };
}

/** Each Nov 1 config branch's change, applied to a copy of the fixture. */
export const configDeltas = {
  c1: (c: Configs) => {
    c.api.vars = { ...c.api.vars, PUBLIC_CORS: "dynamic", PAYMENT_PROVIDER: "fake" };
  },
  c2: (c: Configs) => {
    c.api.vars = {
      ...c.api.vars,
      EMAIL_PROVIDER: "cloudflare",
      EMAIL_FROM_ADDRESS: "bookings@mail.tidegrid.us",
    };
    c.api.send_email = [{ name: "EMAIL", allowed_sender_addresses: ["bookings@mail.tidegrid.us"] }];
  },
  c3: (c: Configs) => {
    c.api.vars = { ...c.api.vars, HOSTNAME_PROVIDER: "cloudflare_saas", CF_SAAS_ZONE_ID: "zone" };
  },
  c4: (c: Configs) => {
    c.guest.routes = [
      ...(c.guest.routes ?? []),
      { pattern: "demo.tidegrid.us", custom_domain: true },
    ];
    c.guest.workers_dev = false;
  },
  c5: (c: Configs) => {
    c.api.vars = { ...c.api.vars, PAYMENT_PROVIDER: "stripe" };
  },
  c6: (c: Configs) => {
    c.api.triggers = { crons: [] };
  },
} as const;

export type ConfigBranch = keyof typeof configDeltas;

/** The fixture with these branches merged, in order. */
export function configsWith(...branches: ConfigBranch[]): Configs {
  const c = fixtureConfigs();
  for (const b of branches) configDeltas[b](c);
  return c;
}

export interface ExecCall {
  cmd: string;
  args: string[];
  options: ExecOptions;
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeOptions {
  env?: Env;
  tty?: boolean;
  answers?: string[];
  /**
   * Answer an exec; default: a clean releasable git on HEAD = origin/main =
   * "a".repeat(40), and a green four-job push run for any SHA gh is asked about.
   */
  exec?: (call: ExecCall) => ExecResult | undefined;
  fetch?: (call: FetchCall) => Response | undefined;
  sql?: (url: string) => SqlClient;
  now?: Date;
  /** The Worker configs; default: the committed fixture (main before any config branch). */
  configs?: Configs;
  /** The running Node version; default: the one `.nvmrc` pins. */
  nodeVersion?: string;
  /**
   * Committed trees for `git show <rev>:<config path>`, keyed by rev (a SHA, or
   * `<sha>^1` for its first parent). null: the file is not in that tree.
   * Default: HEAD's committed tree is `configs`, and no other rev has one.
   */
  committed?: Record<string, Configs | null>;
  /** `git rev-list --first-parent HEAD -- <guest config>`, newest first. Default: [HEAD]. */
  guestHistory?: string[];
}

export const headSha = "a".repeat(40);

export function defaultGit(call: ExecCall): ExecResult | undefined {
  if (call.cmd !== "git") return undefined;
  const a = call.args.join(" ");
  if (a === "rev-parse HEAD" || a === "rev-parse refs/remotes/origin/main")
    return { code: 0, stdout: `${headSha}\n` };
  if (a === "describe --always --dirty") return { code: 0, stdout: "aaaaaaa\n" };
  if (a.startsWith("status --porcelain")) return { code: 0, stdout: "" };
  if (a === "rev-parse --short=7 HEAD") return { code: 0, stdout: "aaaaaaa\n" };
  if (a.startsWith("rev-parse --verify")) return { code: 0, stdout: `${headSha}\n` };
  if (a.endsWith("^{tree}")) return { code: 0, stdout: `${"b".repeat(40)}\n` };
  if (a.startsWith("merge-base --is-ancestor")) return { code: 0, stdout: "" };
  // The committer date the CI gate bounds its dispatch query with: 2026-10-26.
  if (a.startsWith("show -s --format=%ct")) return { code: 0, stdout: "1793000000\n" };
  if (a.startsWith("ls-tree"))
    return { code: 0, stdout: "packages/database/migrations/0013_sweep_fairness.sql\n" };
  return { code: 0, stdout: "" };
}

export function fakeDeps(o: FakeOptions = {}) {
  const execs: ExecCall[] = [];
  const fetches: FetchCall[] = [];
  const printed: string[] = [];
  const prompts: string[] = [];
  const answers = [...(o.answers ?? [])];
  let clock = (o.now ?? new Date("2026-11-01T12:00:00Z")).getTime();
  const stateDir = mkdtempSync(join(tmpdir(), "nov1-state-"));
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call = {
      url: input,
      method: init.method ?? "GET",
      headers,
      body: init.body ? String(init.body) : null,
    };
    fetches.push(call);
    const res = o.fetch?.(call);
    if (!res) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    return res;
  };
  const committedGit = (call: ExecCall): ExecResult | undefined => {
    if (call.cmd !== "git") return undefined;
    if (call.args[0] === "rev-list" && call.args.includes("--first-parent"))
      return { code: 0, stdout: `${(o.guestHistory ?? [headSha]).join("\n")}\n` };
    const show = call.args[0] === "show" ? /^(.+):(.+)$/.exec(call.args[1] ?? "") : null;
    if (!show) return undefined;
    const [, rev, path] = show as unknown as [string, string, string];
    const tree =
      o.committed && rev in o.committed
        ? o.committed[rev]
        : rev === headSha || rev === "HEAD"
          ? (o.configs ?? fixtureConfigs())
          : null;
    const worker = path === configPaths.api ? "api" : path === configPaths.guest ? "guest" : null;
    if (!tree || !worker) return { code: 128, stdout: "" };
    return { code: 0, stdout: JSON.stringify(tree[worker]) };
  };
  const deps: Deps = {
    exec: async (cmd, args, options) => {
      const call = { cmd, args: [...args], options };
      execs.push(call);
      return (
        o.exec?.(call) ??
        committedGit(call) ??
        defaultGit(call) ??
        defaultGh(call) ?? { code: 0, stdout: "[]" }
      );
    },
    fetch: fetchImpl,
    localFetch: fetchImpl,
    env: { PATH: "/usr/bin", HOME: "/home/owner", ...(o.env ?? {}) },
    stdinIsTTY: o.tty ?? true,
    stdoutIsTTY: o.tty ?? true,
    prompt: async (q) => {
      prompts.push(q);
      return answers.shift() ?? "";
    },
    print: (line) => printed.push(line),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    repoRoot,
    stateDir,
    sql:
      o.sql ??
      (() => {
        throw new Error("unexpected database connection");
      }),
    nodeVersion: o.nodeVersion ?? readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim(),
    configs: () => structuredClone(o.configs ?? fixtureConfigs()),
  };
  return { deps, execs, fetches, printed, prompts };
}

/** Commands a dry run may never spawn. */
export const providerCommands = ["wrangler", "dig", "stripe", "npx", "curl", "openssl", "sh"];

export function providerExecs(execs: ExecCall[]): ExecCall[] {
  return execs.filter(
    (e) =>
      providerCommands.includes(e.cmd) ||
      e.args.some((a) => providerCommands.includes(a)) ||
      e.args.includes("release") ||
      e.args.includes("migrate") ||
      e.args.includes("seed") ||
      e.args.includes("neon:branch"),
  );
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export function recordingSql() {
  const statements: { text: string; params: readonly unknown[] }[] = [];
  const answers: Record<string, unknown[]> = {};
  const client: SqlClient = {
    query: async <T>(text: string, params: readonly unknown[] = []) => {
      statements.push({ text, params });
      const key = Object.keys(answers).find((k) => text.includes(k));
      return (key ? answers[key] : []) as T[];
    },
    transaction: async (fn) => fn(client),
    end: async () => {},
  };
  return { client, statements, answers };
}
