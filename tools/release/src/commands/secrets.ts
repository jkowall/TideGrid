/**
 * nov1 secrets <preview|email|stripe|saas> (P3.3, P7, P9, P10; invariant 6).
 *
 * Secret values never pass through nov1: `wrangler secret put NAME` reads the
 * value from the owner's terminal, or from `openssl rand -hex 32` piped inside
 * a shell nov1 starts with no secret in its argv. `wrangler secret list`
 * (names only) is the verification. Each put or delete deploys the running
 * code (cli.js:299145), so it is journaled with the version ids before and
 * after. It is not a rollback anchor: --rollback undoes releases only.
 */
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, Failure, out, type Plan, printPlan, Refusal } from "../core.ts";
import { liveGate } from "../gate.ts";
import { assertReleasable } from "../git.ts";
import { loadJournal, record } from "../journal.ts";
import { type Phase, parsePhase, phaseGuard, phaseIndex } from "../phase.ts";
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
  const chain: SecretSet[] = ["preview", "email", "stripe", "saas"];
  const upto = chain.slice(0, chain.indexOf(set) + 1);
  return ["DATABASE_URL", ...upto.flatMap((s) => secretSets[s].names)].sort();
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
      "Values are typed by the owner at wrangler's prompt, or generated and piped in the owner's terminal. Never argv, --var, a file, or stdout.",
    ],
    steps: [
      {
        id: "1",
        title: "List the API's secret names and diff against this set",
        commands: [
          "pnpm exec wrangler secret list --format json (cwd apps/api-worker; names only)",
        ],
        expect: [`after this set: ${expectedNames(set).join(", ")}`],
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
  onlyFlags(args, ["live", "go", "put", "generate", "delete", "list", "phase"]);
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
    const expected = expectedNames(set);
    const missing = expected.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !expected.includes(n));
    out(deps, `secret names: ${names.join(", ") || "(none)"}`);
    out(
      deps,
      `missing for ${set}: ${missing.join(", ") || "none"}; not expected yet: ${extra.join(", ") || "none"}`,
    );
    return missing.length || extra.length ? 1 : 0;
  }

  const journal = loadJournal(deps);
  if (del) {
    // Feature-off comes before any code rollback (invariant 9), in any phase,
    // whatever config is merged: a delete changes no code and no config.
    out(deps, `feature off: ${name} (no phase guard for a delete)`);
  } else {
    await assertReleasable(deps);
    const guard = phaseGuard(phase, deps.configs(), journal);
    if (guard.refusals.length) throw new Refusal(`phase guard: ${guard.refusals.join("; ")}`);
  }
  if (journal.flags.rolledBack?.includes("api")) {
    throw new Refusal(
      "the API was rolled back, so its latest version is not deployed and secret put fails with 10215. Use `pnpm exec wrangler versions secret put NAME` then `pnpm exec wrangler versions deploy` in apps/api-worker, on the terminal (cli.js:299145).",
    );
  }

  const before = await deployedVersions(deps, "api");
  let code: number;
  if (generate) {
    // The value goes from openssl straight into wrangler's stdin; nov1 never holds it.
    code = await onTerminal(deps, "sh", ["-c", generateCommand(generate)], {
      cwd: `${deps.repoRoot}/apps/api-worker`,
    });
  } else {
    code = await wranglerOnTerminal(deps, "api", ["secret", del ? "delete" : "put", name]);
  }
  const after = await deployedVersions(deps, "api").catch(() => [] as string[]);
  record(deps, {
    phase,
    step: del ? "secret-delete" : "secret-put",
    gate,
    worker: "api",
    result: code === 0 ? "done" : "failed",
    versionBefore: before,
    versionAfter: after,
    note: `${name}; journaled, not a rollback anchor`,
  });
  if (code !== 0)
    throw new Failure(`wrangler secret ${del ? "delete" : "put"} ${name} exited ${code}`);
  out(
    deps,
    `${name} ${del ? "deleted" : "set"}; live version now ${after.join(", ")} (journaled; not a rollback anchor, --rollback undoes releases only)`,
  );
  return 0;
}
