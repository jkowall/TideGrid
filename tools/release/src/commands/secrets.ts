/**
 * nov1 secrets <preview|email|stripe|saas> (P3.3, P7, P9, P10; invariant 6).
 *
 * Secret values never pass through nov1: `wrangler secret put NAME` reads the
 * value from the owner's terminal, or from `openssl rand -hex 32` piped inside
 * a shell nov1 starts with no secret in its argv. The one exception is
 * --from-file (owner decision 2026-11-05, item 3): a Stripe test-mode value
 * from a 0600 file outside the repository, checked by readTestSecret, written
 * to wrangler's stdin, zeroed, and the file removed after a done put.
 *
 * Under --confirm (declared, not typed) a put needs --from-file, since nobody
 * would answer wrangler's value prompt; a delete gives wrangler no stdin, so
 * its own "permanently delete" prompt takes its non-interactive yes (wrangler
 * 4.135.0 confirm2, cli.js:133743) for the one name nov1 checked was declared.
 * `wrangler secret list`
 * (names only) is the verification. Each put or delete deploys the running
 * code (cli.js:299145), so it is journaled with the version ids before and
 * after. It is not a rollback anchor: --rollback undoes releases only.
 */
import { unlinkSync } from "node:fs";
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, type Plan, printPlan, Refusal } from "../core.ts";
import { liveGate } from "../gate.ts";
import { assertReleasable } from "../git.ts";
import { type Journal, loadJournal, record } from "../journal.ts";
import { type Phase, parsePhase, phaseGuard, phaseIndex } from "../phase.ts";
import { assertFileName, readTestSecret } from "../secret-file.ts";
import {
  deployedVersions,
  onTerminal,
  secretNames,
  workers,
  wranglerOnTerminal,
} from "../wrangler.ts";

export type SecretSet = "preview" | "email" | "stripe" | "saas";

/** The API's secrets each set adds, and the gate and phase that set belongs to. */
export const secretSets: Record<SecretSet, { names: string[]; gate: string; phase: Phase }> = {
  preview: { names: ["FAKE_PAYMENT_WEBHOOK_SECRET"], gate: "A2", phase: "p3" },
  email: { names: ["EMAIL_ALLOWED_RECIPIENTS"], gate: "A7", phase: "p7" },
  stripe: { names: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], gate: "A13", phase: "p9" },
  saas: { names: ["CF_SAAS_API_TOKEN"], gate: "A17", phase: "p10" },
};

/** The names expected after each set is on: cumulative, in phase order, DATABASE_URL always. */
export function expectedNames(set: SecretSet): string[] {
  const upto = chain.slice(0, chain.indexOf(set) + 1);
  return ["DATABASE_URL", ...upto.flatMap((s) => secretSets[s].names)].sort();
}

const chain: SecretSet[] = ["preview", "email", "stripe", "saas"];

/**
 * What the journal says is on the API now: each name's last done put or
 * delete, in journal order. Entries before 2026-11-04 carry the name only at
 * the start of the note ("NAME; journaled, ...").
 */
export function journaledSecrets(journal: Journal): { put: string[]; deleted: string[] } {
  const last = new Map<string, "put" | "deleted">();
  for (const e of journal.entries) {
    if (e.result !== "done" || (e.worker !== undefined && e.worker !== "api")) continue;
    if (e.step !== "secret-put" && e.step !== "secret-delete") continue;
    const name = e.secret ?? /^([A-Z][A-Z0-9_]*);/.exec(e.note ?? "")?.[1];
    if (name) last.set(name, e.step === "secret-put" ? "put" : "deleted");
  }
  const pick = (v: "put" | "deleted") =>
    [...last]
      .filter(([, s]) => s === v)
      .map(([n]) => n)
      .sort();
  return { put: pick("put"), deleted: pick("deleted") };
}

/**
 * The names `--list` checks for a set, from what was actually put rather than
 * from the phase chain (finding of 2026-11-04: with P7 skipped, the email name
 * was expected from P7 on and --list exited 1). Required: DATABASE_URL, the
 * set's own names, and every name the journal shows put and not deleted since.
 * Tolerated: an earlier set's name the journal never mentions, present or not
 * (a journal from before nov1 recorded it, or the phase did not run). Anything
 * else present, a deleted name included, is not expected.
 */
export function expectedFor(
  set: SecretSet,
  journal: Journal,
): { required: string[]; tolerated: string[] } {
  const j = journaledSecrets(journal);
  const required = new Set(["DATABASE_URL", ...secretSets[set].names, ...j.put]);
  const tolerated = chain
    .slice(0, chain.indexOf(set))
    .flatMap((s) => secretSets[s].names)
    .filter((n) => !required.has(n) && !j.deleted.includes(n));
  return { required: [...required].sort(), tolerated: tolerated.sort() };
}

/** Only FAKE_PAYMENT_WEBHOOK_SECRET is generated: at least 32 characters (env.ts:27). */
export const generatable = ["FAKE_PAYMENT_WEBHOOK_SECRET"];
const generateCommand = (name: string) =>
  `openssl rand -hex 32 | pnpm exec wrangler secret put ${name}`;

function parseSet(raw: string | undefined): SecretSet {
  if (raw && raw in secretSets) return raw as SecretSet;
  throw new Refusal("name the secret set: preview, email, stripe, or saas");
}

export function secretsPlan(set: SecretSet): Plan {
  const s = secretSets[set];
  return {
    command: `secrets ${set}`,
    target: workers.api.name,
    notes: [
      "Values are typed by the owner at wrangler's prompt, or generated and piped in the owner's terminal. Never argv, --var, or stdout.",
      "A file only with --from-file, and only for a Stripe test-mode value: an sk_test_/rk_test_ STRIPE_SECRET_KEY, or a whsec_ STRIPE_WEBHOOK_SECRET paired with one. 0600, outside the repository, removed after a done put. Live keys are always typed by the owner.",
    ],
    steps: [
      {
        id: "1",
        title: "List the API's secret names and diff against this set",
        commands: [
          "pnpm exec wrangler secret list --format json (cwd apps/api-worker; names only)",
        ],
        expect: [
          `after this set, if every earlier phase ran: ${expectedNames(set).join(", ")}. --list requires DATABASE_URL, this set, and what the journal shows put; an earlier set the journal never mentions is tolerated`,
        ],
        rollback: ["not applicable (read-only)"],
      },
      ...s.names.map((name, i) => ({
        id: `${i + 2}`,
        title: `Put ${name}`,
        gate: s.gate,
        commands: [
          generatable.includes(name)
            ? `nov1 secrets ${set} --generate ${name} --phase <current> --live --go ${s.gate}  # runs: ${generateCommand(name)}`
            : `nov1 secrets ${set} --put ${name} --phase <current> --live --go ${s.gate}  # runs: pnpm exec wrangler secret put ${name}, value typed at its prompt`,
        ],
        envNames: [],
        expect: ["wrangler reports the secret uploaded and a new version deployed"],
        verify: [`wrangler secret list shows ${name}`],
        rollback: [
          `nov1 secrets ${set} --delete ${name} --phase <current> --live --go ${s.gate} (turns the feature off, in any phase)`,
        ],
        cannotRestore: [
          "after a code rollback the latest version is not deployed: secret put and delete fail with 10215; use wrangler versions secret put, then wrangler versions deploy (cli.js:299145)",
        ],
      })),
    ],
  };
}

export async function secrets(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["live", "go", "put", "generate", "delete", "list", "phase", "from-file"]);
  const set = parseSet(args.positional[0]);
  const s = secretSets[set];
  const put = flag(args, "put");
  const generate = flag(args, "generate");
  const del = flag(args, "delete");
  const actions = [put, generate, del].filter(Boolean).length + (args.flags.has("list") ? 1 : 0);
  if (!args.flags.has("live")) {
    printPlan(deps, secretsPlan(set));
    return 0;
  }
  if (actions !== 1)
    throw new Refusal("choose one of --list, --put NAME, --generate NAME, --delete NAME");
  const name = put ?? generate ?? del;
  if (name !== undefined && !s.names.includes(name)) {
    throw new Refusal(`${name} is not in the ${set} set (${s.names.join(", ")})`);
  }
  if (generate !== undefined && !generatable.includes(generate)) {
    throw new Refusal(`${generate} is typed by the owner; use --put`);
  }
  const fromFile = flag(args, "from-file");
  if (fromFile !== undefined) {
    if (put === undefined) throw new Refusal("--from-file goes with --put only");
    assertFileName(put);
  } else if (put !== undefined && deps.declared) {
    throw new Refusal(
      "under --confirm a put needs --from-file: nobody would answer wrangler's value prompt",
    );
  }
  // The phase the day is in, not the set's home phase: a later phase's
  // config may already be merged (review F2). Required for any change.
  let phase: Phase = s.phase;
  if (name !== undefined) {
    if (!flag(args, "phase"))
      throw new Refusal("a secret change needs --phase <the current phase>");
    phase = parsePhase(flag(args, "phase"));
    if (!del && phaseIndex(phase) < phaseIndex(s.phase)) {
      throw new Refusal(
        `the ${set} set is put from ${s.phase.toUpperCase()} on, not in ${phase.toUpperCase()}`,
      );
    }
  }

  const gate = await liveGate(
    deps,
    { live: true, go: flag(args, "go") },
    {
      gates: [s.gate],
      confirm: name ? [workers.api.name, name] : [],
      action: name
        ? `${del ? "delete" : "put"} the API secret ${name}`
        : "list the API's secret names",
      readOnly: !name,
    },
  );

  if (!name) {
    const names = await secretNames(deps);
    const { required, tolerated } = expectedFor(set, loadJournal(deps));
    const missing = required.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !required.includes(n) && !tolerated.includes(n));
    out(deps, `secret names: ${names.join(", ") || "(none)"}`);
    out(deps, `expected (this set and the journal's puts): ${required.join(", ")}`);
    if (tolerated.length)
      out(
        deps,
        `earlier sets the journal never mentions, tolerated either way: ${tolerated.join(", ")}`,
      );
    out(
      deps,
      `missing for ${set}: ${missing.join(", ") || "none"}; not expected: ${extra.join(", ") || "none"}`,
    );
    return missing.length || extra.length ? 1 : 0;
  }

  const journal = loadJournal(deps);
  if (del) {
    // Feature-off comes before any code rollback (invariant 9), in any phase,
    // whatever config is merged: a delete changes no code and no config.
    out(deps, `feature off: ${name} (no phase guard for a delete)`);
  } else {
    await assertReleasable(deps, phase);
    const guard = phaseGuard(phase, deps.configs(), journal);
    if (guard.refusals.length) throw new Refusal(`phase guard: ${guard.refusals.join("; ")}`);
  }
  if (journal.flags.rolledBack?.includes("api")) {
    throw new Refusal(
      "the API was rolled back, so its latest version is not deployed and secret put fails with 10215. Use `pnpm exec wrangler versions secret put NAME` then `pnpm exec wrangler versions deploy` in apps/api-worker, on the terminal (cli.js:299145).",
    );
  }

  // Every refusal comes before the first wrangler call, the version listing included.
  const value = fromFile ? readTestSecret(deps, name, fromFile, journal, phase) : undefined;

  const source = generate ? "generated" : fromFile ? "test-file" : del ? undefined : "typed";
  let code: number;
  let before: string[] = [];
  try {
    before = await deployedVersions(deps, "api");
    // Journaled before wrangler runs, so an interrupted change still shows
    // (the webhook pairing rule reads it).
    record(deps, {
      phase,
      step: del ? "secret-delete" : "secret-put",
      gate,
      worker: "api",
      result: "started",
      versionBefore: before,
      secret: name,
      ...(source ? { source } : {}),
    });
    if (generate) {
      // The value goes from openssl straight into wrangler's stdin; nov1 never holds it.
      code = await onTerminal(deps, "sh", ["-c", generateCommand(generate)], {
        cwd: `${deps.repoRoot}/apps/api-worker`,
      });
    } else if (value) {
      code = await wranglerOnTerminal(deps, "api", ["secret", "put", name], value);
    } else if (del && deps.declared) {
      code = await wranglerOnTerminal(deps, "api", ["secret", "delete", name], "null");
    } else {
      code = await wranglerOnTerminal(deps, "api", ["secret", del ? "delete" : "put", name]);
    }
  } finally {
    value?.fill(0);
  }
  const after = await deployedVersions(deps, "api").catch(() => [] as string[]);
  let fileNote = "";
  let fileLeft = false;
  if (fromFile) {
    if (code === 0) {
      try {
        unlinkSync(fromFile);
        fileNote = "; value from a test-mode file, file removed";
      } catch {
        fileLeft = true;
        fileNote = "; value from a test-mode file, file NOT removed";
      }
    } else {
      fileNote = "; value from a test-mode file, file kept for a retry";
    }
  }
  record(deps, {
    phase,
    step: del ? "secret-delete" : "secret-put",
    gate,
    worker: "api",
    result: code === 0 ? "done" : "failed",
    versionBefore: before,
    versionAfter: after,
    secret: name,
    ...(source ? { source } : {}),
    note: `${name}; journaled, not a rollback anchor${fileNote}`,
  });
  if (code !== 0) {
    if (fromFile) out(deps, `secret file kept for a retry: ${fromFile}`);
    throw new Failure(`wrangler secret ${del ? "delete" : "put"} ${name} exited ${code}`);
  }
  out(
    deps,
    `${name} ${del ? "deleted" : "set"}; live version now ${after.join(", ")} (journaled; not a rollback anchor, --rollback undoes releases only)`,
  );
  if (fileLeft) {
    out(deps, `WARN the secret is set, but nov1 could not remove ${fromFile}; remove it now`);
    return 1;
  }
  if (fromFile) out(deps, `removed ${fromFile}`);
  return 0;
}
