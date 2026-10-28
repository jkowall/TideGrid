import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Deps, Env, ExecOptions, ExecResult, SqlClient } from "../src/core.ts";

export const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

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
  /** Answer an exec; default: a clean releasable git on HEAD = origin/main = "a".repeat(40). */
  exec?: (call: ExecCall) => ExecResult | undefined;
  fetch?: (call: FetchCall) => Response | undefined;
  sql?: (url: string) => SqlClient;
  now?: Date;
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
  const deps: Deps = {
    exec: async (cmd, args, options) => {
      const call = { cmd, args: [...args], options };
      execs.push(call);
      return o.exec?.(call) ?? defaultGit(call) ?? { code: 0, stdout: "[]" };
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
    nodeVersion: "24.22.1",
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
