# TideGrid infrastructure as code (proposed, plan only)

**Status.** Written on 2026-11-08 for goal W3-OPS-1 as a synthetic pull-forward the owner chose ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w3-ops-1-pilot-infrastructure-as-code-plan-only-synthetic-pull-forward-owner-decision-coordinator-defaults-pending-owner-confirmation)). Nothing here has been planned against a real account or applied. No state backend exists. CI runs only `tofu fmt` and `tofu validate`. Every apply needs the owner's approval through the [apply runbook](../../docs/runbooks/terraform-apply.md). TideGrid stays exploratory, and this commits the owner to no provider spending.

## OpenTofu instead of Terraform (2026-11-15)

The owner asked on 2026-11-15 to switch from Terraform to OpenTofu. The configuration did not change: OpenTofu reads the same `.tf` files, the same providers (`cloudflare/cloudflare` 5.28.1 and `kislerdm/neon` 0.18.0, now from the OpenTofu registry), and the same state in the R2 bucket `tidegrid-terraform-state`. What changed:

- The workflows install OpenTofu 1.13.9 with `opentofu/setup-opentofu` and run `tofu` where they ran `terraform`. Locally, use `tofu` (for example `brew install opentofu`).
- Names stay as they were so nothing moves: the folder `infra/terraform`, the bucket `tidegrid-terraform-state`, the lock file name `.terraform.lock.hcl`, the `TF_VAR_` variables, and the "Managed by Terraform." labels on two Cloudflare rulesets and the fallback origin (changing those strings would change live resources).
- The first OpenTofu plan of an environment that Terraform applied must show no changes. A plan never writes state, so until the first OpenTofu apply, going back to Terraform is just reverting the pull request. The first OpenTofu apply copies the state to `backups/<environment>/` beforehand; that copy is the last Terraform-written state, so keep it. It is a way back only if nothing was applied after it. Once OpenTofu has applied changes, restoring it would lose track of what those applies created or changed, so reconcile the resources against the state first, with the owner's go.
- Do not mix the two on one environment: once OpenTofu has applied it, plan and apply it only with OpenTofu.

## What OpenTofu owns, and what it does not

The [hosting plan](../../docs/v2/08-build-hosting-and-operations.md#infrastructure-and-configuration-ownership) splits ownership. These modules follow it.

| Owner | Resources |
|---|---|
| OpenTofu, Cloudflare | Zones, stable Worker routes, queues and dead letter queues, private R2 buckets with object lock and expiry, Hyperdrive configurations, scoped account tokens, alert policies, Cloudflare for SaaS fallback origin |
| OpenTofu, Neon | The project (point-in-time restore window, compute defaults), long-lived branches, their compute |
| Wrangler | Each Worker's code, assets, compatibility settings, limits, and binding declarations, including queue consumers and their dead letter queue, and the custom domains Wrangler declares today (`api`, `console`, the tenant hosts) |
| Migrations | Every database role and grant except the project owner role, which Neon creates with the project. `tidegrid_app` is created only by migration 0001 |
| TideGrid's hostname tooling | Each operator's custom hostname, at onboarding |
| The database package's `neon:branch` tool | Expiring per-pull-request Neon branches |

OpenTofu and Wrangler never manage the same route, binding, or resource. A route moves to OpenTofu only in a change that removes it from the Wrangler configuration at the same time. CI refuses a Neon role resource and any Worker script, version, or deployment resource.

## Layout

```text
infra/terraform/
  environments/
    staging/        existing Cloudflare account and tidegrid.us zone (read only), nonproduction Neon project
    production/     dedicated Cloudflare account and zone, production Neon project
  modules/
    environment/                  composes everything below for one environment
    cloudflare-zone/              one zone, never destroyed by OpenTofu
    cloudflare-routes/            Worker routes OpenTofu owns (none by default)
    cloudflare-queues/            a queue plus its dead letter queue, per purpose
    cloudflare-r2/                private buckets: waiver evidence (object lock), brand assets, documents, backups (expiry)
    cloudflare-hyperdrive/        Neon direct endpoint, query caching always off
    cloudflare-tokens/            scoped, expiring account tokens; values never output
    cloudflare-alerts/            certificate and Cloudflare incident alerts
    cloudflare-custom-hostnames/  Cloudflare for SaaS fallback origin
    cloudflare-security/          firewall rules, edge rate limits, guest Turnstile widget (W3-OPS-4)
    neon/                         project, long-lived branches, compute; never a role
```

Resource names start with `tidegrid-<environment>-`. The environment roots output every identifier Wrangler needs (`wrangler_inputs`), with no secret values. Account ids, zone ids, Neon project ids, hosts, and addresses come from `TF_VAR_` variables at plan time, never from a committed file.

## Edge security (W3-OPS-4)

Added on 2026-11-15, plan only, like the rest. `cloudflare-security` gives each environment:

- **Custom firewall rules** (`http_request_firewall_custom`) on the API host: only the usual methods, only `/v1/` paths, no path traversal, the demo's fake provider and mailbox routes blocked, and no public write without a user agent (verified bots aside). The Stripe webhook path is untouched.
- **Edge rate limits** (`http_ratelimit`), per client address in each Cloudflare location. What a rule may match depends on the zone's plan: Free matches the URI path only, Pro adds the host, Business the method. Production starts with one rule that works on Free: every request to `/v1/public/` paths, 60 per 10 seconds, blocked for 10 seconds. On Business or above, narrow it to writes, add a sign-in rule, and lengthen the block. These sit in front of the Worker's own limiters and the database's limits, which stay.
- **The guest Turnstile widget**, in managed mode, for the domains in `turnstile_domains`. Cloudflare returns the widget's secret and the provider keeps it in state, so the widget is created here only when `allow_secrets_in_state` is true (D1). Otherwise the owner makes it in the dashboard and stores the secret as the API's `TURNSTILE_SECRET_KEY`; `wrangler_inputs.turnstile_site_key` is then null. The site key goes on the API Worker as `TURNSTILE_SITE_KEY`, which hands it to the guest site.
- **Token permissions.** Owning the zone's rules needs the OpenTofu token's zone permission WAF Edit (it covers custom firewall and rate limit rulesets). Creating the widget needs the account permission Turnstile Sites Edit. The [apply runbook](../../docs/runbooks/terraform-apply.md) lists both.

Each zone has one ruleset per phase, so owning one replaces any rules made in the dashboard. Production owns its zone's (`manage_zone_rules = true`). Staging shares the preview's `tidegrid.us` zone and leaves its firewall alone (`false`), so it needs no API host; its next plan adds nothing until `turnstile_domains` is set, and then only the widget. Production needs `api_host` (for example `api.<zone_name>`) beside `zone_name` when it is first planned. The signed waiver bucket and its object lock were already here (`cloudflare-r2`, `waiver-evidence`); the API side is the `WAIVER_EVIDENCE` binding.

## Choices pending the owner (coordinator defaults)

These are recorded in the register entry linked above.

- **D1, no secrets in state, so three resources wait.** The hosting plan says OpenTofu state holds no secret values. A Hyperdrive configuration stores its origin password, an account token stores its value, and a new Neon project stores its default role password. Each environment has `allow_secrets_in_state`, default `false`. While it is false, OpenTofu does not create those three. Hyperdrive and tokens stay as they are made today, and Neon is referenced by project id. Turning it on amends the hosting plan and is the owner's call.
- **D2, state in an S3 bucket.** A partial `backend "s3" {}` block. The owner supplies `backend.hcl` from the private location at `tofu init`: a bucket with versioning on, `encrypt = true` with a KMS key, `use_lockfile = true` for locking, and one key per environment. S3 is the default because it gives encryption, locking, and version history together. R2 has no object versioning. The bucket needs an account the owner does not have yet. Replaced by owner decision on 2026-11-10: a private R2 bucket in the existing Cloudflare account, with a copy of the state kept before each apply; the [`infra-apply` workflow](../../.github/workflows/infra-apply.yml) uses it for staging.
- **D3, staging reads the existing zone.** Staging uses the existing account and the `tidegrid.us` zone by id and never manages the zone. Production gets its own account and zone, created by OpenTofu.
- **D4, Wrangler keeps today's custom domains.** The routes module starts empty.
- **D5, waiver lock period has no default in production.** It is a legal retention decision. Staging locks synthetic evidence for 1 day to prove the lock works.
- **D6, provider versions.** Cloudflare provider `= 5.28.1` and the community Neon provider `kislerdm/neon` `= 0.18.0`, pinned exactly, the "pinned Neon provider" the hosting plan allows. No lock file is committed yet: the goal's container could not reach the OpenTofu registry. CI uploads the lock files it resolves; the first owner-run `init` commits them.

## Checking it

CI ([`.github/workflows/infra.yml`](../../.github/workflows/infra.yml)) runs on every change under `infra/`. It has no secrets. It checks that no state, `*.tfvars`, or `backend.hcl` is committed, that no Neon role, Worker script, custom domain, or queue consumer resource exists, then runs `tofu fmt -check` and `tofu validate` on each environment with `init -backend=false`.

Locally, with OpenTofu 1.11 or later (CI pins 1.13.9):

```sh
tofu fmt -check -recursive infra/terraform
tofu -chdir=infra/terraform/environments/staging init -backend=false
tofu -chdir=infra/terraform/environments/staging validate
```

`validate` needs no credentials and calls no provider API. Never run `plan` or `apply` outside the [apply runbook](../../docs/runbooks/terraform-apply.md).

## Not done here

- No plan per change in CI. A plan reads real accounts, so it needs credentials and a state backend. The hosting plan wants one; it comes with the backend (W3-OPS-3 or the first apply).
- Application alerts (outbox age, dead letter depth, the email account fault, backup age) belong to the observability goal, W3-OPS-5. These modules only cover Cloudflare's own notifications.
- Backup jobs and restore drills are W3-OPS-6: [`tools/backup`](../../tools/backup/README.md), the `backup` and `restore-drill` workflows, and the [runbook](../../docs/runbooks/backup-and-restore.md). OpenTofu creates the bucket, its 35-day expiry, and in production a 7-day lock (`backup_lock_days`).
- The async Worker's Wrangler configuration, which binds the queues, belongs to G2.3 and its release.
