/**
 * Shared plumbing for the nov1 commands: injected effects, output that is
 * always redacted, refusals, and the dry-run plan format.
 *
 * Every effect a command has goes through Deps, so a unit test can assert that
 * a dry run makes no exec or fetch to a provider, and that a live run spawns
 * wrangler on the owner's terminal with a clean environment.
 */
import { redact } from "./redact.ts";

export type Env = Record<string, string | undefined>;

export interface ExecOptions {
  cwd?: string;
  /** The child's whole environment. Build it with childEnv; never pass process.env. */
  env: Env;
  /**
   * inherit: the child shares the owner's terminal (every wrangler deploy,
   * rollback, secret put, and secret delete; invariant 4). pipe: output is
   * captured for parsing (read-only listings with --json only).
   */
  stdio: "inherit" | "pipe";
}

export interface ExecResult {
  code: number;
  stdout: string;
}

export type Exec = (
  cmd: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SqlClient {
  /** Run one parameterized statement. */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run fn inside one transaction. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export interface Deps {
  exec: Exec;
  fetch: Fetch;
  /**
   * Fetch for *.localhost names: connects to 127.0.0.1 and sends the name as
   * Host, because Node's fetch neither resolves every *.localhost nor lets a
   * caller set Host.
   */
  localFetch: Fetch;
  /** The owner's shell environment, read for names and the values commands need. */
  env: Env;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** Ask the owner a question on the terminal and return the answer. */
  prompt: (question: string) => Promise<string>;
  /** Raw output. Commands call out(), which redacts first. */
  print: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** The repository root. */
  repoRoot: string;
  /** Where the journal lives (NOV1_STATE_DIR). Outside the repository. */
  stateDir: string;
  /** An admin database client. Only db, payment-account, and stripe-smoke use it. */
  sql: (url: string) => SqlClient;
  nodeVersion: string;
}

/** A refusal: the command stops and changes nothing. Exit code 3. */
export class Refusal extends Error {
  override name = "Refusal";
}

/** A check that failed after acting, or an expectation not met. Exit code 1. */
export class Failure extends Error {
  override name = "Failure";
}

export function out(deps: Deps, line = ""): void {
  deps.print(redact(line));
}

export interface PlanStep {
  id: string;
  title: string;
  /** Gate id the live step needs, for example A4. */
  gate?: string | undefined;
  commands: string[];
  /** Environment variable names the step reads. Never values. */
  envNames?: string[];
  expect: string[];
  verify?: string[];
  rollback: string[];
  /** What the rollback cannot restore. */
  cannotRestore?: string[];
}

export interface Plan {
  command: string;
  target: string;
  steps: PlanStep[];
  notes?: string[];
}

/** The dry-run text: exact commands, env names, expected output, and rollback per step. */
export function renderPlan(plan: Plan): string[] {
  const lines = [`DRY RUN: nov1 ${plan.command}`, `target: ${plan.target}`];
  lines.push(
    "No command below has run. Nothing was sent to wrangler, dig, Neon, Stripe, or Cloudflare.",
  );
  for (const note of plan.notes ?? []) lines.push(`note: ${note}`);
  for (const step of plan.steps) {
    lines.push("");
    lines.push(`[${step.id}] ${step.title}${step.gate ? ` (gate ${step.gate})` : ""}`);
    for (const c of step.commands) lines.push(`  run:      ${c}`);
    if (step.envNames?.length) lines.push(`  env:      ${step.envNames.join(", ")} (names only)`);
    for (const e of step.expect) lines.push(`  expect:   ${e}`);
    for (const v of step.verify ?? []) lines.push(`  verify:   ${v}`);
    for (const r of step.rollback) lines.push(`  rollback: ${r}`);
    for (const c of step.cannotRestore ?? []) lines.push(`  rollback cannot restore: ${c}`);
  }
  return lines;
}

export function printPlan(deps: Deps, plan: Plan): void {
  for (const line of renderPlan(plan)) out(deps, line);
}

export const banner =
  "nov1 is the only deploy path today. Never run `pnpm --filter <app> run release` or `pnpm deploy:demo` directly.";

/** Wait until check() is true, polling every intervalMs, or give up after timeoutMs. */
export async function poll<T>(
  deps: Deps,
  check: () => Promise<T | null>,
  { intervalMs, timeoutMs }: { intervalMs: number; timeoutMs: number },
): Promise<T | null> {
  const started = deps.now().getTime();
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (deps.now().getTime() - started >= timeoutMs) return null;
    await deps.sleep(intervalMs);
  }
}
