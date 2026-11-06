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
- The value is checked as bytes, never turned into a string, written to wrangler's stdin, and the buffer is zeroed afterwards; it is never in argv, output, or the journal. After a done put, `nov1` removes the file and journals that it did (`source: "test-file"`). After a failed put the file stays for a retry.

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
| `evidence` | Draft the verification-log entry; step 9 by tree equality |

Exit codes: 0 done, 1 a check failed, 2 usage, 3 refused (nothing changed).

## Tests

`pnpm --filter @tidegrid/release test` runs the unit tests with injected `exec`, `fetch`, and database clients. Public API bodies in the stripe-smoke test come from `test/contract-fixtures.ts`, which parses each with its `@tidegrid/contracts` schema, so a mock cannot drift from the contract. The suite covers: dry runs make no provider call, every gate refusal, wrangler stdio and environment, redaction, the phase guard, the rate budget, and the refusals of `db platform`, `payment-account`, and `hostname-disable`, and declared confirmations and test-mode secret files (`test/declared-confirm.test.ts`). CI Part B also runs `smoke`, `last-seat`, and `isolation` for real with `--profile local` (`apps/guest-site/e2e/full/release-scripts.spec.ts`).
