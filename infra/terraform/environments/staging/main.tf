# Staging: dedicated staging Workers, queues, R2 buckets, and Hyperdrive in the
# existing Cloudflare account, on the existing product zone, against a
# long-lived branch in the nonproduction Neon project (hosting plan,
# environment matrix). The zone is only referenced, never managed, from here.

module "environment" {
  source = "../../modules/environment"

  environment            = "staging"
  allow_secrets_in_state = var.allow_secrets_in_state

  cloudflare_account_id = var.cloudflare_account_id
  zone = {
    name        = "tidegrid.us"
    create      = false
    existing_id = var.zone_id
  }

  queues = {
    outbox = {}
  }

  # Staging holds synthetic waivers only, so a short lock is enough to prove
  # the lock works.
  waiver_evidence_lock_days = 1
  backup_expire_days        = 7

  hyperdrive          = var.hyperdrive
  hyperdrive_password = var.hyperdrive_password
  tokens              = var.tokens

  alert_email_destinations      = var.alert_email_destinations
  alert_webhook_destination_ids = []

  # No operator domain is attached before the pilot.
  custom_hostname_fallback = null

  # The nonproduction project already exists, so it is referenced by id.
  neon_project_id = var.neon_project_id
  neon_branches = {
    staging = {
      protected = false
      compute = {
        min_cu                  = 0.25
        max_cu                  = 1
        suspend_timeout_seconds = 300
      }
    }
  }
}
