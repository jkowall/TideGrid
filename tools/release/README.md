# @tidegrid/release (`nov1`)

The commands behind the [Nov 1 runbook](../../docs/runbooks/2026-11-01-preview-deploy.md) (proposed). Node built-ins and lockfile packages only.

```sh
alias nov1='pnpm --silent --filter @tidegrid/release nov1'
nov1 help
```

## Safety model

- **Live is decided by target.** Loopback and `*.localhost` targets are local and run with no gate; CI uses only those. Any other host is live.
- **Dry run is the default.** A live target without `--live` prints the exact commands, the environment variable names, the expected output, and the rollback, and runs nothing.
- **A live run needs all of:** `--live`, `--go <gate>` for that step, a terminal on stdin and stdout, `CI` unset, and the target typed back (or declared with `--confirm`, below). Read-only network steps (A0) skip the typed target.
- **Re-checked just before acting:** HEAD equals `origin/main` and is in the journal's approved SHAs, `packages/database/migrations` is clean, `git describe --dirty` is clean, no build-leak variable is set, and the phase guard passes.
- **Wrangler on the terminal.** Every deploy, rollback, secret put, and secret delete is spawned with stdio `inherit`; a non-TTY stdout would silently override DNS records and custom-domain origins (wrangler 4.135.0 `cli.js:153833-153836`). Version ids come from a separate `deployments list --json` call, ids only.
- **Clean child environments.** Built from an allowlist. `CLOUDFLARE_API_TOKEN` is always stripped, and the strip is printed. The admin database URL is mapped from `--url-env` into `DATABASE_URL` in the child only.
- **No secret passes through `nov1`, with one exception.** Values are typed at wrangler's prompt, or piped from `openssl rand -hex 32` inside a shell with no secret in its argv. The exception is a Stripe test-mode value from a file (`--from-file`, below). Every printed or journaled line is redacted; an argv that looks like a secret, an account id, a personal address, a credentialed URL, or `--api-key` is refused before anything is spawned.
- **The journal** lives in `NOV1_STATE_DIR` (default `~/.claude/projects/-Users-jkowall-TideGrid/handoff/nov1/`), mode 0600, with no secret, address, or account id.
- **Private artifacts** (the Access storage state, deployed traces) live only in `NOV1_PRIVATE_DIR`, mode 0700, outside the repository and `~/.claude`. The Playwright deployed modes refuse anything else (`src/deployed-gate.ts`).

## Declared confirmations (unattended runs)

The owner allows scripted type-backs when the owner directs an unattended run, with targets declared up front, and secret values from files for test-mode secrets only ([decision register, 2026-11-05](../../docs/v2/06-decision-register.md)). `nov1` does both itself, so the guard is tested here rather than in a loose script.

- **`--confirm <target>[,<target>...]`** on any command. Each entry is exactly what the owner would type: a Worker name, a database host, a hostname, a secret name, or a SHA's first 12 (`approve-sha`). The yes/no attestation `nov1` cannot check itself is declared by id: `yes:db-at-tree` (the first API release, when the health cannot report migrations).
- **Every prompted target must be declared.** `nov1` then asks nothing. A target or question not declared refuses with nothing run (exit 3); there is no fallback to typing. Declared entries never asked for are named at the end.
- **Rollbacks stay typed.** `release --rollback` refuses under `--confirm`, and so does `yes:feature-off`, which only a rollback asks. `wrangler rollback` asks for a message, whether to deploy to 100%, and, when secrets changed since the anchor, whether to go on (wrangler 4.135.0 `cli.js:349347`, `349367`, `349392`). Declaring that last answer would be a new question for the owner.
- **The journal says so.** Each declared answer is a `confirm` entry with result `answered`, `confirmation: "declared"`, and the targets asked for, before the step it gated; the step keeps its own entry. A target not declared is a `confirm` entry with result `refused`. An approval made this way carries `confirmation: "declared"`, and `nov1 evidence` prints "declared, not typed" beside it.
- **The other rules hold.** `--confirm` refuses when `CI` is set. A live step still needs `--live`, `--go`, and a terminal on stdin and stdout, because wrangler with a non-TTY stdout overrides DNS records and custom-domain origins. An unattended run supplies the terminal with a plain pty that answers nothing, for example `script -q /dev/null pnpm --silent --filter @tidegrid/release nov1 ... --confirm ... </dev/null`. Nothing answers a wrangler prompt `nov1` did not expect (the guard scripts of 2026-11-04 stopped on one); how wrangler reacts to end of file there is not verified, so bound each unattended step with a time limit.
- **Entries are checked.** An empty entry, an entry shaped like a secret or an account id, or a `yes:` id other than `yes:db-at-tree` refuses before anything runs.

**Secrets.** Under `--confirm`, `secrets --put` needs `--from-file`, since nobody would answer wrangler's value prompt. `secrets --delete` gives wrangler no stdin, so wrangler's own "permanently delete" prompt takes its non-interactive yes (wrangler 4.135.0 `confirm2`, `cli.js:133743`); the secret name must be declared, so that yes covers only the declared name. Typed runs keep wrangler's prompt on the terminal.

**`--from-file <path>`** goes with `secrets <set> --put NAME` only, typed or declared:

- Only `STRIPE_SECRET_KEY` (an `sk_test_` or `rk_test_` key) and `STRIPE_WEBHOOK_SECRET` (a `whsec_` value). A live key is refused: live-mode keys always go through the owner. Every other name is typed by the owner.
- A `whsec_` value does not say whether its endpoint is test or live, and `nov1` makes no live call to ask. By the owner's selection it is accepted only when the shell's `STRIPE_SECRET_KEY` is a test key and the journal shows the API's `STRIPE_SECRET_KEY` put from a test-mode file in the same phase, with nothing since that could have changed it: no later put or delete of the key in any result, and no API rollback. Every secret put and delete is journaled as `started` before wrangler runs, so an interrupted one counts. That is an inference, not a proof; a change made outside `nov1` (for example `wrangler versions secret put`) is not seen.
- The file is an absolute path to a regular file with one link (no symlink, no hard link), owned by the caller, mode 0600, one line, outside the repository and outside any directory with a `.git` above it (so the main checkout is refused from a worktree too). It is read once through `O_NOFOLLOW` and re-checked on the open descriptor.
- The value is checked as bytes, never turned into a string, written to wrangler's stdin, and the buffer is zeroed afterwards; it is never in argv, output, or the journal. After a done put, `nov1` removes the file, only if the path still names the file it read (same device and inode), and journals that it did (`source: "test-file"`). Removal happens before the post-put version listing, so a stalled listing cannot leave the file. If the path now names another file, nothing is removed and `nov1` says the secret file was not removed (exit 1). If a hard link to it was made during the put, or between the identity check and the unlink, `nov1` removes its own name but says the secret is still on disk under another name (exit 1): the file is held open through the unlink and its link count is read from that descriptor afterwards. An incomplete cleanup skips the post-put listing, so its journal entry and warning come at once. An empty path is refused like any other non-absolute one. After a failed put the file stays for a retry.

## CI gate (proposed 2026-11-07, built 2026-11-08)

`approve-sha` and `release` refuse a SHA unless a completed run of `ci.yml` on `main` is green on all four jobs (checks, integration, browser, console-browser) and tested that SHA ([decision register, 2026-11-08](../../docs/v2/06-decision-register.md#2026-11-08-nov1-refuses-a-sha-without-a-green-four-job-ci-run-owner-request-coordinator-defaults-pending-owner-confirmation)). The code is `src/ci-status.ts`. D3 is an owner decision of 2026-11-08; the other choices below are coordinator defaults pending owner confirmation.

- **Which runs count.** A run of `.github/workflows/ci.yml` in `jkowall/TideGrid`, whose page is that repository's run URL, on `main`. A push run counts for its head. A dispatch run counts for the SHA its name gives, `ci on <the full SHA>`, or, when its name is the workflow's own (`ci`, a blank input), for its head (D3). A dispatch counts as a pass only when its head is on `origin/main` locally, so the workflow file that ran is one `main` had (a tag named `main` gets nothing). One whose head looks off `main` still blocks when it is not green, since a stale `origin/main` can make a real dispatch look off `main`. When a run's head is not in this clone at all, the step refuses and asks for `git fetch origin`, so a stale clone never hides a newer run. Pull request runs never count: they test a merge commit.
- **The newest run decides (D4).** The runs that tested the SHA are ordered by when their latest attempt started, so a re-run is the newest word. The newest decides: queued or in progress refuses until it ends, even when an older run passed; a failure refuses; a newer green dispatch after a failed push run passes. One exception: a first attempt cancelled before any job started (a duplicate dispatch that GitHub dropped from its concurrency group) said nothing, so it is skipped. A retry cancelled before it started hides how the earlier attempt ended, so it refuses. Every page of each runs list is read, with no date bound, up to 1,000 runs (GitHub's cap for a filtered list); more than that refuses. A committer date can lie and a run can be re-run long after it was created, so no date bound is safe. There are 6 dispatch runs on `main` today; at 1,000, every SHA would refuse until old runs are deleted. A run row or job record that cannot be read refuses rather than being dropped, and a run seen twice keeps its highest attempt.
- **Every job is read.** The run's own conclusion is not enough: `dd30fc8`'s push run concluded success with three jobs skipped. In the run's latest attempt, each of the four jobs must appear once, on the run's head, completed, with conclusion `success`. Skipped, failed, cancelled, missing, and still running all refuse, and the refusal names the job and the run's URL.
- **GitHub through `gh`'s own login (D1).** `nov1` runs `gh api --hostname github.com -X GET` on two read-only endpoints of `jkowall/TideGrid`: the workflow's runs list, and one run's jobs. It never reads, passes, or prints a token. `gh` gets the usual allowlisted child environment, plus `GH_CONFIG_DIR` when set, so `GH_TOKEN` and `GITHUB_TOKEN` in the shell never reach it: log in with `gh auth login` on the release machine, with the token in the macOS keychain or `gh`'s own config. `gh` writes its own errors to the terminal. `nov1` prints only the run's URL as `nov1` forms it, and a run or job state from GitHub's known list. It triggers nothing; for a SHA with no run, the refusal names the dispatch command for the owner to run.
- **GitHub unreachable (D2).** When `gh` is missing, logged out, cannot reach GitHub, or answers something that is not the expected JSON, the step refuses. There is no override. `HTTPS_PROXY` is not passed, so a machine that needs a proxy always refuses. There is no time limit on `gh` either; a stalled connection waits until Ctrl-C.
- **Order.** `approve-sha` checks CI after the ancestry check and before the owner types the first 12, so a refusal asks nothing. `release` checks CI after the typed Worker name and the existing checks (HEAD is approved `origin/main`, clean migrations and tree, no build leak) and before the phase guard. That includes `release guest --kill-switch`, which deploys the tree: it refuses too when GitHub cannot be read or HEAD's run is not green. A rollback deploys a recorded version, not the tree, and `--verify` deploys nothing, so neither asks GitHub.
- **The journal.** Every decision is a `ci-check` entry with the SHA, the gate, and the phase. A pass has result `done` and a note with the run's URL, whether it was a push or a dispatch run, and the attempt. A refusal has result `refused` and the reason. `approve-sha` also prints the run's URL with the approval.
- **Not covered.** `src/redact.ts` has no rule for GitHub token shapes (`ghp_`, `github_pat_`, and the like). No path in `nov1` reads one today; a rule is a proposed follow-up from the security review. A dispatch head on `main` is trusted to carry a guarded workflow; three older `ci.yml` versions on `main` have a weaker guard that still checks the checked-out commit, so a run from them still tested the SHA.
- **Tests.** `test/ci-gate.test.ts`, with `test/ci-fixtures.ts`: the recorded runs of `7ef50cf` (passes) and `dd30fc8` (refused), the recorded shape of the 2026-11-08 dispatches with a cancelled duplicate, and every refusal for both commands. The shared fake answers `gh` with a green push run, so the earlier suites test what they tested before.

## Wrangler 4.152.0 re-verification (W1-TOOLING, 2026-11-08)

The three apps pin wrangler 4.152.0 exactly, and the Workers test pool resolves the same version through `pnpm.overrides` ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w1-tooling-wrangler-41520-and-the-workers-test-pool-owner-go-start-gate-waived-by-the-owner-coordinator-defaults-pending-owner-confirmation); the owner confirmed the versions on 2026-11-08). The pin is exact so that the line references below cannot drift with a lockfile refresh. Nothing was released or deployed.

`nov1` relies on wrangler behavior it cannot test, since the unit tests mock wrangler. Each reading was re-read in `node_modules/.pnpm/wrangler@4.152.0_@types+node@24.13.6/node_modules/wrangler/wrangler-dist/cli.js` and compared with the 4.135.0 file. The sections above keep their 4.135.0 line numbers; the comments and refusal texts in `src` now cite 4.152.0 lines.

| Reading | 4.135.0 | 4.152.0 | Status |
|---|---|---|---|
| Non-TTY stdout overrides DNS records and custom-domain origins | 153833-153836 | 164530-164533 | held (`publishCustomDomains` identical but for one renamed variable) |
| A confirmation without a TTY on stdin and stdout takes its fallback, yes (`confirm2`, `isNonInteractiveOrCI`) | 133743-133751, 29138-29153 | 139679-139688, 35198-35213 | held; `secrets --delete` relies on it for the declared name |
| `secret delete` asks through `confirm2` | 299224-299226 | 311775-311777 | held |
| `secret put` reads stdin when stdin is not a TTY | 299125 | 311678-311680 | held; `--from-file` relies on it |
| `secret list` prints JSON by default | 299246 | 311797-311813 | held |
| A secret put after a code rollback fails with 10215 | 299076, 299143-299147 | 311623, 311510-311521 | held; 10214 now gets the same message |
| `wrangler rollback` asks for a message, a 100% deploy, and, after secrets changed, whether to go on | 349347, 349368, 349393 | 361300, 361321, 361351 | held, so a rollback stays typed |
| Declining the 10220 prompt exits 0 | 349407-349415 | 361368-361371 | held for exit 0. 4.135.0 then printed its success line; 4.152.0 returns without it. The postcondition (the anchor alone is live) is still required |
| A rollback leaves bound resources unchanged | 349363 | 361316 | held |
| `deployments list` sorts oldest first and carries author emails | 349050, 348974, 349090 | 361001, 360925, 361041 | held; only ids are parsed |

Also changed, and relied on by nothing here: `wrangler deploy` now always keeps secret bindings (`keepSecrets: true`, 181291; 4.135.0 kept them only with `--keep-vars` or `--secrets-file`, 170042). No `nov1` step relies on a deploy removing a secret; secrets are removed only by `secrets --delete`, so no step changes. `wrangler deploy` and `wrangler rollback` now also send a Durable Objects code-update strategy in every deployment request, `deferred` with a 300 s delay by default (`createDeployment` 168444-168461, deploy 181401-181410, rollback 361331-361342 and 361356-361367, default 220730-220745). 4.135.0 sent no such field (`createDeployment` 157424-157440, rollback 349377-349405), and rollback gains a `--durable-objects-code-update-mode` argument (361251) that `nov1` does not pass. No Worker here binds a Durable Object. Whether the deployments API accepts the field for such a Worker on a rollback is unverified, since checking it needs a live call. A refusal would fail the step before traffic moves, and `nov1` counts a rollback done only when the anchor alone is live. The prototype's `npx wrangler@4.125.0` pin in the root scripts is untouched until the prototype is retired.

## Commands

| Command | Purpose |
|---|---|
| `preflight` | Offline by default: Node, build environment, release state, phase guard, `pnpm release:dry`, bundle checks, pending migrations. `--network --go A0` adds the login type, deployed version ids, and DNS |
| `db status\|backup\|migrate\|seed\|outbox-summary\|platform` | Neon main through `--url-env`. Refuses in a shell that could rotate `tidegrid_app` or seed local hosts |
| `secrets <set>` | List, put, generate, or delete the API's secrets for a phase; journaled as deploys. `--from-file` for Stripe test-mode values only |
| `release <worker>` | Release or roll back one Worker; postcondition by health, Access redirect, or host checks |
| `smoke`, `last-seat`, `isolation` | HTTP checks with `--profile local` (CI) or `preview` (Nov 1) |
| `accept <guest\|console>` | The only way to set `NOV1_GO` for the Playwright deployed modes |
| `stripe-smoke` | Server-side Stripe test-mode run; test keys only; spawns nothing |
| `payment-account set <slug> stripe` | Admin insert of a stripe payment account from `STRIPE_ACCT_<SLUG>` |
| `hostname-disable <slug> <hostname>` | The only path to `hostnames disable`; custom rows only |
| `approve-sha <sha>` | Add the frozen SHA or a config merge to the approved list; an approval counts from its gate's phase on |
| `evidence` | Draft the verification-log entry; step 9 by tree equality, or, for a SHA CI tested itself on `main` or by dispatch, `--ci <sha>=<the same full sha>` (compared as resolved commits) |

Exit codes: 0 done, 1 a check failed, 2 usage, 3 refused (nothing changed).

## Tests

`pnpm --filter @tidegrid/release test` runs the unit tests with injected `exec`, `fetch`, and database clients. Public API bodies in the stripe-smoke test come from `test/contract-fixtures.ts`, which parses each with its `@tidegrid/contracts` schema, so a mock cannot drift from the contract. The suite covers: dry runs make no provider call, every gate refusal, wrangler stdio and environment, redaction, the phase guard, the rate budget, and the refusals of `db platform`, `payment-account`, and `hostname-disable`, and declared confirmations and test-mode secret files (`test/declared-confirm.test.ts`). CI Part B also runs `smoke`, `last-seat`, and `isolation` for real with `--profile local` (`apps/guest-site/e2e/full/release-scripts.spec.ts`).
