/**
 * Live is decided by target, not by a flag (invariant 1). A local target runs
 * with no gate. Any other target is live, and a live run needs all of: --live,
 * --go <gate>, a terminal on stdin and stdout, CI unset, and the owner typing
 * the target back. Without --live, a live target only prints its plan.
 *
 * An unattended run the owner directs may declare the type-backs up front
 * with --confirm (owner decision 2026-11-05, item 2). Then nov1 asks nothing:
 * each prompt is satisfied only when its exact answer was declared, anything
 * else refuses with nothing run, and both outcomes are journaled as declared.
 * The terminal and CI rules still hold.
 */
import { type Declared, type Deps, out, Refusal } from "./core.ts";
import { record } from "./journal.ts";
import { hasSecretShape } from "./redact.ts";

export type TargetKind = "local" | "live";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Local: loopback, or a name under .localhost. Everything else, an empty host included, is live. */
export function classifyHost(hostname: string): TargetKind {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (loopbackHosts.has(h) || h.endsWith(".localhost")) return "local";
  return "live";
}

/** Classify a URL of any scheme (https, http, postgres, postgresql). An unparsable one is live. */
export function classifyUrl(raw: string): TargetKind {
  try {
    return classifyHost(new URL(raw).hostname);
  } catch {
    return "live";
  }
}

/** The host to show and to type back, without credentials, path, or query. */
export function displayHost(raw: string): string {
  try {
    const u = new URL(raw);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "<unparsable>";
  }
}

export interface LiveOptions {
  live: boolean;
  go: string | undefined;
}

export interface GateSpec {
  /** Gate ids that may authorize this step. */
  gates: readonly string[];
  /** What the owner types back: a Worker name, a database host, or a hostname. */
  confirm: string[];
  /** One line on what is about to happen, printed before the prompt. */
  action: string;
  /** Read-only network steps (A0) skip the typed confirmation. */
  readOnly?: boolean;
}

/**
 * Run the live gate. Returns the gate id that authorized the step. Throws a
 * Refusal on any missing condition, before anything is spawned or fetched.
 */
export async function liveGate(deps: Deps, opts: LiveOptions, spec: GateSpec): Promise<string> {
  if (!opts.live)
    throw new Refusal("a live target needs --live (without it, nov1 prints the plan)");
  if (!opts.go) throw new Refusal(`a live run needs --go <gate>, one of ${spec.gates.join(", ")}`);
  if (!spec.gates.includes(opts.go)) {
    throw new Refusal(
      `--go ${opts.go} does not authorize this step; it needs ${spec.gates.join(" or ")}`,
    );
  }
  if (deps.env.CI) throw new Refusal("CI is set: live steps never run in CI");
  if (!deps.stdinIsTTY || !deps.stdoutIsTTY) {
    throw new Refusal("live steps need a terminal on stdin and stdout (no pipes, no redirects)");
  }
  out(deps, `LIVE (gate ${opts.go}): ${spec.action}`);
  if (spec.readOnly) return opts.go;
  if (deps.declared) {
    declaredCheck(deps, deps.declared, opts.go, spec.confirm, spec.action);
    return opts.go;
  }
  for (const expected of spec.confirm) {
    const typed = (await deps.prompt(`Type ${expected} to continue, anything else stops: `)).trim();
    if (typed !== expected)
      throw new Refusal(`typed confirmation did not match ${expected}; nothing ran`);
  }
  return opts.go;
}

/**
 * The yes/no attestations nov1 cannot check itself. Under --confirm each is
 * answered only by declaring `yes:<id>` (owner selection 2026-11-05).
 */
export const yesQuestions = {
  "db-at-tree": "the database is already at the tree's last migration (first API release)",
  "feature-off": "the feature is already off, or not needed, before a rollback",
} as const;

export type YesQuestion = keyof typeof yesQuestions;

/**
 * Commands whose own wrangler step asks questions --confirm cannot answer.
 * `wrangler rollback` (4.152.0) asks for a message (cli.js:361300), whether to
 * deploy to 100% (cli.js:361321), and, when secrets changed since the anchor,
 * whether to go on (cli.js:361351). That last one is a new question the
 * owner has not ruled on, so a rollback stays typed, and yes:feature-off,
 * which only a rollback asks, cannot be declared until it is.
 */
export const typedOnly =
  "a rollback is typed by the owner: wrangler asks for a message, a 100% deploy, and a changed-secrets answer that --confirm does not cover";

/**
 * Ask a yes or no question; only an exact "yes" goes ahead. Under --confirm
 * the question is not asked: it goes ahead only when `yes:<id>` is declared,
 * and otherwise refuses.
 */
export async function confirmYes(deps: Deps, id: YesQuestion, question: string): Promise<boolean> {
  if (deps.declared) {
    declaredCheck(deps, deps.declared, undefined, [`yes:${id}`], question);
    return true;
  }
  return (await deps.prompt(`${question} Type yes to go ahead: `)).trim() === "yes";
}

/** Parse --confirm: comma-separated, each entry exactly what the owner would type. */
export function parseDeclared(raw: string): Declared {
  const targets = raw.split(",").map((t) => t.trim());
  if (targets.some((t) => t === ""))
    throw new Refusal("--confirm has an empty entry; list each target once, comma-separated");
  for (const t of targets) {
    if (hasSecretShape(t)) throw new Refusal("a --confirm entry looks like a secret or an id");
    if (t === "yes:feature-off") throw new Refusal(`--confirm yes:feature-off: ${typedOnly}`);
    if (t.startsWith("yes:") && !Object.hasOwn(yesQuestions, t.slice(4))) {
      throw new Refusal(
        `--confirm ${t} names no question; the questions are ${Object.keys(yesQuestions)
          .filter((q) => q !== "feature-off")
          .map((q) => `yes:${q}`)
          .join(", ")}`,
      );
    }
  }
  return { targets, used: new Set() };
}

/**
 * Satisfy a type-back from the declared targets, or refuse. Journals the
 * outcome either way, so the journal shows the answer was declared, not typed.
 */
export function declaredCheck(
  deps: Deps,
  declared: Declared,
  gate: string | undefined,
  expected: readonly string[],
  action: string,
): void {
  for (const t of expected) declared.used.add(t);
  const missing = expected.filter((t) => !declared.targets.includes(t));
  const entry = {
    phase: "-",
    step: "confirm",
    ...(gate ? { gate } : {}),
    confirmation: "declared" as const,
    targets: [...expected],
  };
  if (missing.length) {
    record(deps, { ...entry, result: "refused", note: `not declared: ${missing.join(", ")}` });
    throw new Refusal(
      `--confirm does not cover this step; not declared: ${missing
        .map((t) => (t.startsWith("yes:") ? `${t} (--confirm ${t})` : t))
        .join(", ")}. Nothing ran`,
    );
  }
  record(deps, { ...entry, result: "answered", note: action });
  out(deps, `confirmed from --confirm, declared, not typed: ${expected.join(", ")}`);
}
