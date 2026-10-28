/**
 * nov1 evidence (P12). Drafts the verification-log entry "Demo acceptance on
 * the preview deployment, November 1, 2026" from the journal. Step 9 is checked
 * by tree equality (D10(a)): each deployed SHA's tree must equal the tree of
 * the PR run's test merge commit, which the run's checkout step prints after
 * `git log -1 --format=%H`. Fetch that commit first: `git fetch origin <merge>`.
 *
 * The draft carries names, ids, references, and results only; it is redacted,
 * and a unit test asserts it holds no address outside the .test domains.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, out, Refusal } from "../core.ts";
import { git } from "../git.ts";
import { type Journal, loadJournal } from "../journal.ts";
import { redact } from "../redact.ts";

export interface TreeCheck {
  deployed: string;
  merge: string;
  deployedTree: string;
  mergeTree: string;
  equal: boolean;
}

export function parseCiPairs(raw: string | undefined): { deployed: string; merge: string }[] {
  if (!raw) return [];
  return raw.split(",").map((pair) => {
    const [deployed, merge] = pair.split("=");
    if (
      !deployed ||
      !merge ||
      !/^[0-9a-f]{7,40}$/.test(deployed) ||
      !/^[0-9a-f]{40}$/.test(merge)
    ) {
      throw new Refusal(`--ci takes <deployed sha>=<40-character merge sha>; bad ${pair}`);
    }
    return { deployed, merge };
  });
}

export function renderEvidence(journal: Journal, trees: TreeCheck[], now: Date): string {
  const lines: string[] = [];
  lines.push("## Demo acceptance on the preview deployment, November 1, 2026 (draft)");
  lines.push("");
  lines.push(
    `Drafted by nov1 evidence at ${now.toISOString()} from the journal. Synthetic data only.`,
  );
  lines.push("");
  lines.push("**Approved SHAs.**");
  for (const a of journal.approved) {
    lines.push(
      `- ${a.sha} (tree ${a.tree}) under ${a.gate}${a.frozen ? ", the frozen release SHA" : ""}${a.lastMigration ? `, last migration ${a.lastMigration}` : ""}.`,
    );
  }
  lines.push("");
  lines.push("**Steps, in order.**");
  lines.push("");
  lines.push(
    "| Time (UTC) | Phase | Step | Gate | Result | Worker | Versions before | Versions after | Note |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const e of journal.entries) {
    lines.push(
      `| ${e.at} | ${e.phase} | ${e.step} | ${e.gate ?? ""} | ${e.result} | ${e.worker ?? ""} | ${(e.versionBefore ?? []).join(" ")} | ${(e.versionAfter ?? []).join(" ")} | ${e.note ?? ""} |`,
    );
  }
  lines.push("");
  lines.push(
    "**Step 6, what it shows.** No oversell through the deployed stack, with the racers serialized through one client address by the checkout's per-client lock (`packages/domain-booking/src/checkout.ts:177`). Concurrent hold acquisition is proven by the database race suites, not by this run.",
  );
  lines.push("");
  lines.push("**Step 9, tree equality (D10(a)).**");
  if (trees.length === 0) lines.push("- Not shown: no --ci pairs given.");
  for (const t of trees) {
    lines.push(
      `- ${t.deployed} tree ${t.deployedTree} ${t.equal ? "equals" : "DIFFERS FROM"} the PR run's merge commit ${t.merge} tree ${t.mergeTree}.`,
    );
  }
  lines.push("");
  lines.push(
    "**Recorded by the owner (fill in).** Per-step pass, fail, or not shown with its dependency; booking references; CSV control totals; the race counts; the isolation table; SPF, DKIM, and DMARC results; the messageId comparison; destination verification; the claim-window observation; the waiver hash; CI run URLs; Neon compute before and after.",
  );
  lines.push("");
  lines.push(`Flags: ${JSON.stringify(journal.flags)}.`);
  return redact(lines.join("\n"));
}

export async function evidence(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["ci", "out"]);
  const journal = loadJournal(deps);
  const trees: TreeCheck[] = [];
  for (const { deployed, merge } of parseCiPairs(flag(args, "ci"))) {
    const deployedTree = await git(deps, ["rev-parse", `${deployed}^{tree}`]);
    const mergeTree = await git(deps, ["rev-parse", `${merge}^{tree}`]);
    trees.push({ deployed, merge, deployedTree, mergeTree, equal: deployedTree === mergeTree });
  }
  const draft = renderEvidence(journal, trees, deps.now());
  const name = flag(args, "out");
  if (name) {
    if (!/^[a-z0-9._-]+\.md$/.test(name))
      throw new Refusal("--out takes a file name; it is written in NOV1_STATE_DIR");
    writeFileSync(join(deps.stateDir, name), `${draft}\n`, { mode: 0o600 });
    out(deps, `draft written to ${join(deps.stateDir, name)}`);
  } else {
    for (const line of draft.split("\n")) out(deps, line);
  }
  return trees.every((t) => t.equal) ? 0 : 1;
}
