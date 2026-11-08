# Terraform apply (proposed, never run)

**Status.** Proposed on 2026-11-08 with goal W3-OPS-1 ([decision register](../v2/06-decision-register.md#2026-11-08-w3-ops-1-pilot-infrastructure-as-code-plan-only-synthetic-pull-forward-owner-decision-coordinator-defaults-pending-owner-confirmation)). It has never run. No state backend exists yet. Nothing in it runs before the pilot gate, and every apply needs the owner's approval for that apply. The code is in [`infra/terraform`](../../infra/terraform/README.md).

## Rules

- **The owner approves each apply.** An apply runs only after the owner has read that exact saved plan and said go for it. A workflow, an agent message, or an earlier go is never approval for a new plan.
- **Saved plans only.** Apply only a plan file made by `terraform plan -out`, never a bare `terraform apply`. A plan that changes after review is a new plan.
- **No destroy without a separate go.** Any `destroy` or `must be replaced` line on a zone, bucket, Neon project, or protected branch stops the run. Zones, buckets, and the Neon project also carry `prevent_destroy`.
- **No secrets in the repository, logs, or chat.** Credentials come from the owner's private location into the shell environment only. Plan output can name hosts and ids: keep it out of the repository and out of pull requests.
- **Remote state only.** Never run `init` without the backend settings, so state never lands on a laptop.
- **Production waits for staging.** The same commit applies to staging first and passes its checks before production is planned.

## One-time setup (owner)

1. Choose the state backend (D2). The default is an S3 bucket in a new account the owner controls, with versioning on, a KMS key, and access limited to the owner and the apply identity. Write `backend.hcl` in the private location, one per environment:

   ```hcl
   bucket       = "<state bucket>"
   key          = "tidegrid/<environment>.tfstate"
   region       = "<region>"
   encrypt      = true
   kms_key_id   = "<kms key arn>"
   use_lockfile = true
   ```

2. Create a Cloudflare API token for Terraform with only the permissions the modules need (zone, Workers routes, Queues, R2, Hyperdrive, Notifications, and, if D1 changes, Account API Tokens), scoped to the environment's account, with an expiry. Store it in the private location as `CLOUDFLARE_API_TOKEN`.
3. Create a Neon API key scoped to the project where the plan offers one. Store it as `NEON_API_KEY`.
4. Put the environment's `TF_VAR_` values (account id, zone id, Neon project id, alert addresses) in the private location. Never in a `.tfvars` file inside the repository.

## Each apply

Run from a clean checkout of `main` at the commit to apply, on the owner's machine.

1. `git status` is clean and `HEAD` is the reviewed commit. The [`infra` workflow](../../.github/workflows/infra.yml) is green for it.
2. Load credentials into this shell only: `set -a; source <private env file>; set +a`. Never print them.
3. `terraform -chdir=infra/terraform/environments/<environment> init -backend-config=<private backend.hcl>`. On the first init, commit the generated `.terraform.lock.hcl` in a separate pull request.
4. `terraform -chdir=infra/terraform/environments/<environment> plan -out=<private dir>/<environment>.tfplan`.
5. Read the plan. Check: no destroy or replace on a protected resource; no Neon role; no Worker script; no resource Wrangler already declares; the counts match what the change meant to do.
6. Owner go for this plan. Record the commit, the environment, and the plan's add, change, and destroy counts.
7. `terraform -chdir=infra/terraform/environments/<environment> apply <private dir>/<environment>.tfplan`.
8. `terraform -chdir=infra/terraform/environments/<environment> output wrangler_inputs` and put the ids into that environment's Wrangler configuration in a reviewed pull request. Wrangler must not bind a resource before it exists, so the Wrangler change merges after the apply.
9. Delete the plan file. Record the evidence (commit, counts, time, no ids or hosts) in the [verification log](../verification-log.md).

## Rollback

- A bad change: revert the commit in a pull request, then plan and apply the revert under the same rules.
- Never edit state by hand. If state and the account disagree, stop and ask the owner. Console changes are for incidents only, and the owner imports them into code afterwards (hosting plan).
- Restore state from the backend's version history only with the owner's go.
