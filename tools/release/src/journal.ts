/**
 * The Nov 1 journal (invariant 5): what ran, under which gate, and the version
 * ids before and after every deploy, rollback, or secret change. It lives at
 * NOV1_STATE_DIR, outside the repository, mode 0600 in a 0700 directory. It
 * holds no secret, no personal address, and no account id: every string is
 * redacted on the way in.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./core.ts";
import { redact } from "./redact.ts";

export type Worker = "api" | "console" | "guest";

export interface ApprovedSha {
  sha: string;
  tree: string;
  gate: string;
  at: string;
  /** The frozen release SHA (P0.1) rather than a later config merge. */
  frozen?: boolean;
  lastMigration?: string;
}

export interface Entry {
  at: string;
  phase: string;
  step: string;
  gate?: string;
  result: "started" | "done" | "failed" | "skipped" | "refused";
  worker?: Worker;
  sha?: string;
  buildId?: string;
  versionBefore?: string[];
  versionAfter?: string[];
  note?: string;
}

export interface Journal {
  version: 1;
  approved: ApprovedSha[];
  entries: Entry[];
  flags: {
    cronPaused?: boolean;
    cutoverDone?: boolean;
    saasEnabled?: boolean;
    /** Workers whose deployed version is not their latest (after a rollback). */
    rolledBack?: Worker[];
  };
}

export const emptyJournal = (): Journal => ({ version: 1, approved: [], entries: [], flags: {} });

export function journalPath(deps: Deps): string {
  return join(deps.stateDir, "journal.json");
}

export function loadJournal(deps: Deps): Journal {
  const path = journalPath(deps);
  if (!existsSync(path)) return emptyJournal();
  return JSON.parse(readFileSync(path, "utf8")) as Journal;
}

function scrub<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}

export function saveJournal(deps: Deps, journal: Journal): void {
  mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(deps.stateDir, 0o700);
  const path = journalPath(deps);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(scrub(journal), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function record(deps: Deps, entry: Omit<Entry, "at">): Entry {
  const journal = loadJournal(deps);
  const full: Entry = { at: deps.now().toISOString(), ...entry };
  journal.entries.push(full);
  saveJournal(deps, journal);
  return full;
}

export function updateFlags(deps: Deps, change: (flags: Journal["flags"]) => void): void {
  const journal = loadJournal(deps);
  change(journal.flags);
  saveJournal(deps, journal);
}

/** The last done entry for a step, optionally for one worker. */
export function lastDone(journal: Journal, step: string, worker?: Worker): Entry | undefined {
  return [...journal.entries]
    .reverse()
    .find((e) => e.step === step && e.result === "done" && (!worker || e.worker === worker));
}
