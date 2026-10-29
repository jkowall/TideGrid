/**
 * The phase guard (invariant 11). Each Nov 1 phase allows one provider
 * configuration. The guard reads the Worker configs on disk, the ones wrangler
 * is about to deploy, and refuses a config that belongs to another phase. It
 * runs in preflight and again just before every wrangler call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal } from "./journal.ts";

export const phases = [
  "p0",
  "p1",
  "p2",
  "p3",
  "p4",
  "p5",
  "p6",
  "p7",
  "p8",
  "p9",
  "p10",
  "p11",
  "p12",
] as const;
export type Phase = (typeof phases)[number];

export function parsePhase(raw: string | undefined): Phase {
  const p = (raw ?? "").toLowerCase();
  if (!(phases as readonly string[]).includes(p)) {
    throw new Error(`--phase must be one of ${phases.join(", ")}`);
  }
  return p as Phase;
}

const order = (p: Phase) => phases.indexOf(p);
export const phaseIndex = order;

/** JSON with comments and trailing commas, as wrangler.jsonc allows. */
export function parseJsonc(text: string): unknown {
  let result = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      result += c;
      if (c === "\\") {
        result += next ?? "";
        i++;
      } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      result += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      result += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else result += c;
  }
  return JSON.parse(result.replace(/,(\s*[}\]])/g, "$1"));
}

interface WorkerConfig {
  name?: string;
  workers_dev?: boolean;
  routes?: { pattern: string; custom_domain?: boolean }[];
  vars?: Record<string, string>;
  send_email?: { name: string; allowed_sender_addresses?: string[] }[];
  triggers?: { crons?: string[] };
}

export interface Configs {
  api: WorkerConfig;
  guest: WorkerConfig;
}

export function loadConfigs(repoRoot: string): Configs {
  const read = (path: string) =>
    parseJsonc(readFileSync(join(repoRoot, path), "utf8")) as WorkerConfig;
  return {
    api: read("apps/api-worker/wrangler.jsonc"),
    guest: read("apps/guest-site/wrangler.jsonc"),
  };
}

/** The sender when EMAIL_FROM_ADDRESS is unset (apps/api-worker/src/email.ts:60). */
export const defaultFromAddress = "bookings@tidegrid.us";
export const previewHostnames = ["demo-harbor.book.tidegrid.us", "demo-reef.book.tidegrid.us"];
export const cutoverHostnames = [...previewHostnames, "demo.tidegrid.us"];

export interface GuardResult {
  refusals: string[];
  warnings: string[];
}

/**
 * The guard for `phase`. The journal says what earlier phases already did, so
 * a cutover that happened (P8) stays allowed in later phases.
 */
export function phaseGuard(phase: Phase, configs: Configs, journal: Journal): GuardResult {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const vars = configs.api.vars ?? {};

  if (vars.PAYMENT_PROVIDER === "stripe" && phase !== "p9") {
    refusals.push(
      "PAYMENT_PROVIDER is stripe outside P9: C5 belongs to the Stripe window only. At the end of P9, revert C5 and release the API with the fake (runbook P9.6)",
    );
  }

  const email = configs.api.send_email ?? [];
  const emailOn = email.length > 0 || vars.EMAIL_PROVIDER !== undefined;
  if (emailOn && order(phase) < order("p7")) {
    refusals.push("a send_email binding or EMAIL_PROVIDER is set before P7 (C2 is G2.16-live)");
  }
  if (emailOn) {
    const senders = email.flatMap((b) => b.allowed_sender_addresses ?? []);
    const from = vars.EMAIL_FROM_ADDRESS || defaultFromAddress;
    if (email.length !== 1 || senders.length !== 1) {
      refusals.push("the send_email binding must have exactly one allowed_sender_addresses entry");
    } else if (senders[0] !== from) {
      refusals.push(
        `EMAIL_FROM_ADDRESS${vars.EMAIL_FROM_ADDRESS ? "" : " (unset, so the default)"} is not the binding's one allowed sender`,
      );
    }
  }

  const isPreview = isPreviewConfig(configs);
  const isCutover = isCutoverConfig(configs);
  const cutoverAllowed = phase === "p8" || journal.flags.cutoverDone === true;
  if (isCutover && !cutoverAllowed) {
    refusals.push("the guest config carries the demo.tidegrid.us cutover (C4) outside P8");
  } else if (!isPreview && !isCutover) {
    refusals.push(
      "the guest routes are not exactly the two preview names with workers_dev on, nor the reviewed cutover set",
    );
  }

  const saasOn = isSaasConfig(configs);
  if (saasOn && phase !== "p10" && journal.flags.saasEnabled !== true) {
    refusals.push("HOSTNAME_PROVIDER or CF_SAAS_ZONE_ID is set outside P10 (C3 is deferred, D9)");
  }

  if (order(phase) >= order("p3") && vars.PUBLIC_CORS !== "dynamic") {
    warnings.push(
      "PUBLIC_CORS is not dynamic: C1 is not merged, so the preview hosts cannot read the API (acceptance step 1 fails)",
    );
  }

  const crons = configs.api.triggers?.crons ?? [];
  if (journal.flags.cronPaused && crons.length > 0) {
    warnings.push(
      "the journal says the cron is paused, but this config carries a cron: releasing it restarts the */15 wakes",
    );
  }
  return { refusals, warnings };
}

const guestRoutes = (c: Configs) => (c.guest.routes ?? []).map((r) => r.pattern).sort();

/** The guest config before the cutover: the two preview names, workers.dev on. */
export function isPreviewConfig(c: Configs): boolean {
  return same(guestRoutes(c), previewHostnames) && c.guest.workers_dev === true;
}

/** The reviewed cutover set (C4): the preview names and demo.tidegrid.us, workers.dev off. */
export function isCutoverConfig(c: Configs): boolean {
  return same(guestRoutes(c), cutoverHostnames) && c.guest.workers_dev === false;
}

export function isSaasConfig(c: Configs): boolean {
  const vars = c.api.vars ?? {};
  return vars.HOSTNAME_PROVIDER !== undefined || vars.CF_SAAS_ZONE_ID !== undefined;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  const sb = [...b].sort();
  return a.length === sb.length && a.every((v, i) => v === sb[i]);
}
