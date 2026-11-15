# 5. Releases and rollback

Putting a new version of the API, the console, or the guest site live, checking it, and going back when it is wrong.

**Status today.** Releases run from the owner's Mac with the release tool, `nov1` ([tools/release](../../../tools/release/README.md)), following the release form of the [Nov 1 runbook](../2026-11-01-preview-deploy.md). Database migrations run from GitHub first ([Neon migrations from CI](../neon-migrate-ci.md)). Work is under way to move Worker releases into GitHub with one approval click. When that lands, its runbook replaces the "How a release runs today" steps below; the rules and the rollback scenarios here stay.

**The order is always** migrate the database, then the API, then the console, then the guest site. The guest site binds to the API, and an API on an older database fails. Never release a SHA whose CI run on `main` is not green on all four jobs; the release tool refuses it anyway.

**Traffic steps.** Pilot traffic is too low for a gradual rollout to tell anything. A release goes to 100% at once, at a quiet time (not on a morning with early departures), and the check after it is the real test.

## How a release runs today

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | The owner's approval of the SHA (`approve-sha`) and each live step |
| Safe first action | `nov1 preflight --offline`, which changes nothing |
| Customer impact check | The check after release (below) |
| Evidence | The release tool's journal on the Mac, the GitHub runs, and a verification log entry with version ids |
| Limit | A Worker rollback does not undo a migration or a secret change |
| Communication | Tell operators beforehand only if they will see a change in how they work |
| Closed when | Health shows the new version and the check after release passes |

1. Merge to `main`. Wait for `ci.yml` to be green on all four jobs for that SHA.
2. If the release has migrations: dispatch `neon-migrate` for the SHA, approve it, and read "pending 0" in its summary.
3. On the Mac, at `main`, in one pasted block: `approve-sha`, `preflight --offline`, then `release api`, `release console`, `release guest`, each with `--live --go` and `--confirm` for the type-backs.
4. Run the check after release.

## The check after release

There is no 5-minute synthetic booking yet; that came with paging, which is set aside for the paid pilots. Run these by hand after every release:

1. `https://api.tidegrid.us/v1/health`: `version` is the new build, `database` is `ok`, `migrations.latest` is the last file in the tree.
2. `nov1 smoke --profile preview ... --live --go A0` (read-only HTTP): each operator's host resolves to its own brand, and the negative probes answer the shared 404.
3. Open the console: it asks for sign-in, and after it shows the overview.
4. On a phone, open one operator's booking page and go as far as the payment step without paying.
5. Within an hour, read Workers Logs for new error lines.

If any step fails, decide in ten minutes: fix forward fast, or roll back.

## A release broke something

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for the rollback (it stays typed by design) |
| Safe first action | Check health and say which of API, console, or guest is wrong |
| Customer impact check | Errors in Workers Logs since the release time; operator reports |
| Evidence | Release journal entries for the release and the rollback; incident record |
| Limit | Rolls back code only. Bindings, secrets, and the database stay as they are |
| Communication | TideGrid owner tells operators if they saw errors |
| Closed when | The previous version alone is live, health is ok, and the check after release passes on it |

**High**; **Critical** if no one can book or pay.

1. Roll back only the Worker that is wrong: `nov1 release <api|console|guest> --phase <phase> --rollback --live --go <gate>`. It names the version it goes back to and asks you to type the Worker name and the version's first 8 characters.
2. If wrangler asks whether to roll back although secrets changed, answer yes. Declining aborts but still exits as if it worked.
3. The tool counts the rollback done only when the old version alone is live.
4. After an API rollback, a secret change fails until the next real release. Do not change secrets in between unless the incident needs it; the Nov 1 runbook's P3 rollback has the path if so.
5. Fix the cause on `main` and release again normally.

**When not to roll back the API.** If the release included a migration that the older API cannot work with, a rollback makes things worse. Migrations are written so the older API keeps working, and the [database README](../../../packages/database/README.md) section for each migration says whether that holds, under "Applying it". Read it before rolling the API back. If the older API cannot work, forward-fix instead ([guide 6](06-database-changes.md)).

## The guest site serves an old or broken page from its offline cache

Installed copies of the guest site keep a service worker and a cache.

1. Release the guest site with `--kill-switch` (the tool sets `GUEST_SW_KILL_SWITCH=1` for that build). That release unregisters the service worker and clears caches on the next visit.
2. After the bad version is gone from every phone that matters (allow a day), release a normal guest build.

## A release is half done

The API went out but the console or guest failed, or a release stopped in the middle.

1. Read health and the release tool's output. Which Worker is on which version?
2. API changes are made to keep working for the console and guest site one release behind, so a half release is usually safe for a short time. That is a practice, not something tested for every release. Finish the release, or roll the API back, within the hour.
3. Never leave the API on a database older than its tree. The release tool refuses that, but a manual `wrangler` command would not. Do not use bare `wrangler deploy` on production.

## Secrets

Secret changes deploy the running code with the new value. They are journaled like releases but are not rollback points. To undo one, put the old value back or delete it. Leaked secrets: [guide 9](09-security-incidents.md#leaked-secret).
