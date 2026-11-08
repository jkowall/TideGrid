# TideGrid infrastructure as code (proposed, plan only)

**Status.** Written on 2026-11-08 for goal W3-OPS-1 as a synthetic pull-forward the owner chose ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w3-ops-1-pilot-infrastructure-as-code-plan-only-synthetic-pull-forward-owner-decision-coordinator-defaults-pending-owner-confirmation)). Nothing here has been planned against a real account or applied. No state backend exists. CI runs only `terraform fmt` and `terraform validate`. Every apply needs the owner's approval through the [apply runbook](../../docs/runbooks/terraform-apply.md). TideGrid stays exploratory, and this commits the owner to no provider spending.

## What Terraform owns, and what it does not

The [hosting plan](../../docs/v2/08-build-hosting-and-operations.md#infrastructure-and-configuration-ownership) splits ownership. These modules follow it.

| Owner | Resources |
|---|---|
| Terraform, Cloudflare | Zones, stable Worker routes, queues and dead letter queues, private R2 buckets with object lock and expiry, Hyperdrive configurations, scoped account tokens, alert policies, Cloudflare for SaaS fallback origin |
| Terraform, Neon | The project (point-in-time restore window, compute defaults), long-lived branches, their compute |
| Wrangler | Each Worker's code, assets, compatibility settings, limits, and binding declarations, including queue consumers and their dead letter queue, and the custom domains Wrangler declares today (`api`, `console`, the tenant hosts) |
| Migrations | Every database role and grant. `tidegrid_app` is created only by migration 0001 |
| TideGrid's hostname tooling | Each operator's custom hostname, at onboarding |
| The database package's `neon:branch` tool | Expiring per-pull-request Neon branches |

Terraform and Wrangler never manage the same route, binding, or resource. A route moves to Terraform only in a change that removes it from the Wrangler configuration at the same time. CI refuses a Neon role resource and any Worker script, version, or deployment resource.

## Layout

```text
infra/terraform/
  environments/
    staging/        existing Cloudflare account and tidegrid.us zone (read only), nonproduction Neon project
    production/     dedicated Cloudflare account and zone, production Neon project
  modules/
    environment/                  composes everything below for one environment
    cloudflare-zone/              one zone, never destroyed by Terraform
    cloudflare-routes/            Worker routes Terraform owns (none by default)
    cloudflare-queues/            a queue plus its dead letter queue, per purpose
    cloudflare-r2/                private buckets: waiver evidence (object lock), brand assets, documents, backups (expiry)
    cloudflare-hyperdrive/        Neon direct endpoint, query caching always off
    cloudflare-tokens/            scoped, expiring account tokens; values never output
    cloudflare-alerts/            certificate and Cloudflare incident alerts
    cloudflare-custom-hostnames/  Cloudflare for SaaS fallback origin
    neon/                         project, long-lived branches, compute; never a role
```

Resource names start with `tidegrid-<environment>-`. The environment roots output every identifier Wrangler needs (`wrangler_inputs`), with no secret values. Account ids, zone ids, Neon project ids, hosts, and addresses come from `TF_VAR_` variables at plan time, never from a committed file.

## Choices pending the owner (coordinator defaults)

These are recorded in the register entry linked above.

- **D1, no secrets in state, so three resources wait.** The hosting plan says Terraform state holds no secret values. A Hyperdrive configuration stores its origin password, an account token stores its value, and a new Neon project stores its default role password. Each environment has `allow_secrets_in_state`, default `false`. While it is false, Terraform does not create those three. Hyperdrive and tokens stay as they are made today, and Neon is referenced by project id. Turning it on amends the hosting plan and is the owner's call.
- **D2, state in an S3 bucket.** A partial `backend "s3" {}` block. The owner supplies `backend.hcl` from the private location at `terraform init`: a bucket with versioning on, `encrypt = true` with a KMS key, `use_lockfile = true` for locking, and one key per environment. S3 is the default because it gives encryption, locking, and version history together. R2 has no object versioning. The bucket needs an account the owner does not have yet.
- **D3, staging reads the existing zone.** Staging uses the existing account and the `tidegrid.us` zone by id and never manages the zone. Production gets its own account and zone, created by Terraform.
- **D4, Wrangler keeps today's custom domains.** The routes module starts empty.
- **D5, waiver lock period has no default in production.** It is a legal retention decision. Staging locks synthetic evidence for 1 day to prove the lock works.
- **D6, provider versions.** Cloudflare provider `~> 5.28` and the community Neon provider `kislerdm/neon` `~> 0.18`, the "pinned Neon provider" the hosting plan allows. No lock file is committed yet: the goal's container could not reach the Terraform registry. CI uploads the lock files it resolves; the first owner-run `init` commits them.

## Checking it

CI ([`.github/workflows/infra.yml`](../../.github/workflows/infra.yml)) runs on every change under `infra/`. It has no secrets. It checks that no state, `*.tfvars`, or `backend.hcl` is committed, that no Neon role or Worker script resource exists, then runs `terraform fmt -check` and `terraform validate` on each environment with `init -backend=false`.

Locally, with Terraform 1.11 or later:

```sh
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/environments/staging init -backend=false
terraform -chdir=infra/terraform/environments/staging validate
```

`validate` needs no credentials and calls no provider API. Never run `plan` or `apply` outside the [apply runbook](../../docs/runbooks/terraform-apply.md).

## Not done here

- No plan per change in CI. A plan reads real accounts, so it needs credentials and a state backend. The hosting plan wants one; it comes with the backend (W3-OPS-3 or the first apply).
- Application alerts (outbox age, dead letter depth, the email account fault, backup age) belong to the observability goal, W3-OPS-5. These modules only cover Cloudflare's own notifications.
- Backup jobs and restore drills belong to W3-OPS-6. This only creates the bucket.
- The async Worker's Wrangler configuration, which binds the queues, belongs to G2.3 and its release.
