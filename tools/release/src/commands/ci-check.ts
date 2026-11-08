/**
 * nov1 ci-check <full sha> (proposed 2026-11-08). The CI gate on its own:
 * read-only, no journal, no prompt. Exit 0 when a completed ci.yml run on
 * main is green on all four jobs for the SHA (the same rule approve-sha and
 * release use, src/ci-status.ts), and 3 with the reason otherwise.
 *
 * It runs under CI on purpose: the neon-migrate workflow calls it before the
 * job that holds the Neon secrets. It changes nothing and reads GitHub
 * through gh's own login, so the "live steps never run in CI" rule is not
 * touched. In the workflow that login comes from the job's own read-only
 * token, written to a throwaway GH_CONFIG_DIR.
 */
import { type Args, onlyFlags } from "../args.ts";
import { ciJobs, ciStatus } from "../ci-status.ts";
import { type Deps, out, Refusal } from "../core.ts";

export async function ciCheck(deps: Deps, args: Args): Promise<number> {
  onlyFlags(args, []);
  const sha = args.positional[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || args.positional.length !== 1)
    throw new Refusal("nov1 ci-check <full 40-character sha>");
  const pass = await ciStatus(deps, sha);
  out(
    deps,
    `CI green for ${sha.slice(0, 12)}: ${pass.url} (${pass.via} run, attempt ${pass.attempt}), ${ciJobs.join(", ")}`,
  );
  return 0;
}
