# @tidegrid/release (`nov1`)

The commands behind the [Nov 1 runbook](../../docs/runbooks/2026-11-01-preview-deploy.md) (proposed). Node built-ins and lockfile packages only.

```sh
alias nov1='pnpm --silent --filter @tidegrid/release nov1'
nov1 help
```

## Safety model

- **Live is decided by target.** Loopback and `*.localhost` targets are local and run with no gate; CI uses only those. Any other host is live.
- **Dry run is the default.** A live target without `--live` prints the exact commands, the environment variable names, the expected output, and the rollback, and runs nothing.
- **A live run needs all of:** `--live`, `--go <gate>` for that step, a terminal on stdin and stdout, `CI` unset, and the target typed back. Read-only network steps (A0) skip the typed target.
- **Re-checked just before acting:** HEAD equals `origin/main` and is in the journal's approved SHAs, `packages/database/migrations` is clean, `git describe --dirty` is clean, no build-leak variable is set, and the phase guard passes.
- **Wrangler on the terminal.** Every deploy, rollback, secret put, and secret delete is spawned with stdio `inherit`; a non-TTY stdout would silently override DNS records and custom-domain origins (wrangler 4.135.0 `cli.js:153833-153836`). Version ids come from a separate `deployments list --json` call, ids only.
- **Clean child environments.** Built from an allowlist. `CLOUDFLARE_API_TOKEN` is always stripped, and the strip is printed. The admin database URL is mapped from `--url-env` into `DATABASE_URL` in the child only.
- **No secret passes through `nov1`.** Values are typed at wrangler's prompt, or piped from `openssl rand -hex 32` inside a shell with no secret in its argv. Every printed or journaled line is redacted; an argv that looks like a secret, an account id, a personal address, a credentialed URL, or `--api-key` is refused before anything is spawned.
- **The journal** lives in `NOV1_STATE_DIR` (default `~/.claude/projects/-Users-jkowall-TideGrid/handoff/nov1/`), mode 0600, with no secret, address, or account id.
- **Private artifacts** (the Access storage state, deployed traces) live only in `NOV1_PRIVATE_DIR`, mode 0700, outside the repository and `~/.claude`. The Playwright deployed modes refuse anything else (`src/deployed-gate.ts`).

## Commands

| Command | Purpose |
|---|---|
| `preflight` | Offline by default: Node, build environment, release state, phase guard, `pnpm release:dry`, bundle checks, pending migrations. `--network --go A0` adds the login type, deployed version ids, and DNS |
| `db status\|backup\|migrate\|seed\|outbox-summary\|platform` | Neon main through `--url-env`. Refuses in a shell that could rotate `tidegrid_app` or seed local hosts |
| `secrets <set>` | List, put, generate, or delete the API's secrets for a phase; journaled as deploys |
| `release <worker>` | Release or roll back one Worker; postcondition by health, Access redirect, or host checks |
| `smoke`, `last-seat`, `isolation` | HTTP checks with `--profile local` (CI) or `preview` (Nov 1) |
| `accept <guest\|console>` | The only way to set `NOV1_GO` for the Playwright deployed modes |
| `stripe-smoke` | Server-side Stripe test-mode run; test keys only; spawns nothing |
| `payment-account set <slug> stripe` | Admin insert of a stripe payment account from `STRIPE_ACCT_<SLUG>` |
| `hostname-disable <slug> <hostname>` | The only path to `hostnames disable`; custom rows only |
| `approve-sha <sha>` | Add the frozen SHA or a config merge to the approved list |
| `evidence` | Draft the verification-log entry; step 9 by tree equality |

Exit codes: 0 done, 1 a check failed, 2 usage, 3 refused (nothing changed).

## Tests

`pnpm --filter @tidegrid/release test` runs the unit tests with injected `exec`, `fetch`, and database clients: dry runs make no provider call, every gate refusal, wrangler stdio and environment, redaction, the phase guard, the rate budget, and the refusals of `db platform`, `payment-account`, and `hostname-disable`. CI Part B also runs `smoke`, `last-seat`, and `isolation` for real with `--profile local` (`apps/guest-site/e2e/full/release-scripts.spec.ts`).
