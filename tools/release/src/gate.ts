/**
 * Live is decided by target, not by a flag (invariant 1). A local target runs
 * with no gate. Any other target is live, and a live run needs all of: --live,
 * --go <gate>, a terminal on stdin and stdout, CI unset, and the owner typing
 * the target back. Without --live, a live target only prints its plan.
 */
import { type Deps, out, Refusal } from "./core.ts";

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
  for (const expected of spec.confirm) {
    const typed = (await deps.prompt(`Type ${expected} to continue, anything else stops: `)).trim();
    if (typed !== expected)
      throw new Refusal(`typed confirmation did not match ${expected}; nothing ran`);
  }
  return opts.go;
}

/** Ask a yes or no question; only an exact "yes" goes ahead. */
export async function confirmYes(deps: Deps, question: string): Promise<boolean> {
  return (await deps.prompt(`${question} Type yes to go ahead: `)).trim() === "yes";
}
