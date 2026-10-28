/**
 * nov1 approve-sha <sha> (P0.1, P3.1, P7, P8, P9, P11). Adds a commit to the
 * journal's approved list: the frozen release SHA (--frozen), or a config
 * merge under its gate. Every live step refuses a HEAD that is not on it
 * (invariant 3). Local: git reads and the journal only.
 */
import { type Args, flag, onlyFlags } from "../args.ts";
import { type Deps, out, Refusal } from "../core.ts";
import { childEnv } from "../env.ts";
import { git } from "../git.ts";
import { loadJournal, saveJournal } from "../journal.ts";

export const approveGates = ["P0.1", "A3", "A8", "A10", "A13", "A17", "A19"] as const;

export async function approveSha(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, ["go", "frozen"]);
  const raw = args.positional[0];
  if (!raw || !/^[0-9a-f]{7,40}$/.test(raw))
    throw new Refusal("nov1 approve-sha <sha> --go <gate> | --frozen");
  const frozen = args.flags.has("frozen");
  const gate = frozen ? "P0.1" : flag(args, "go");
  if (!gate || !(approveGates as readonly string[]).includes(gate)) {
    throw new Refusal(`--go must be one of ${approveGates.join(", ")}, or --frozen`);
  }
  if (deps.env.CI) throw new Refusal("CI is set; approvals are the owner's");
  if (!deps.stdinIsTTY || !deps.stdoutIsTTY) throw new Refusal("approve-sha needs a terminal");
  const sha = await git(deps, ["rev-parse", "--verify", `${raw}^{commit}`]);
  const tree = await git(deps, ["rev-parse", `${sha}^{tree}`]);
  const onMain = await deps.exec(
    "git",
    ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"],
    {
      cwd: deps.repoRoot,
      env: childEnv(deps),
      stdio: "pipe",
    },
  );
  if (onMain.code !== 0)
    throw new Refusal(`${sha.slice(0, 12)} is not on origin/main; approve merged commits only`);
  const files = (
    await git(deps, ["ls-tree", "--name-only", sha, "packages/database/migrations/"])
  ).split("\n");
  const lastMigration = files
    .map((f) => f.split("/").pop() ?? "")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .at(-1);
  const typed = (
    await deps.prompt(`Type the first 12 characters of ${sha} to approve it under ${gate}: `)
  ).trim();
  if (typed !== sha.slice(0, 12)) throw new Refusal("typed SHA did not match; nothing recorded");
  const journal = loadJournal(deps);
  if (journal.approved.some((a) => a.sha === sha && a.gate === gate)) {
    out(deps, `${sha.slice(0, 12)} is already approved under ${gate}`);
    return 0;
  }
  journal.approved.push({
    sha,
    tree,
    gate,
    at: deps.now().toISOString(),
    ...(frozen ? { frozen: true } : {}),
    ...(lastMigration ? { lastMigration } : {}),
  });
  saveJournal(deps, journal);
  out(
    deps,
    `approved ${sha} (tree ${tree}, last migration ${lastMigration ?? "none"}) under ${gate}`,
  );
  return 0;
}
