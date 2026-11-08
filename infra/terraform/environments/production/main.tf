# Production: a dedicated Cloudflare account and zone, and a Neon project on a
# paid plan with a protected root branch (hosting plan, environment matrix).
# Nothing here is applied before the pilot gate and the owner's approval of
# each apply (docs/runbooks/terraform-apply.md).

module "environment" {
  source = "../../modules/environment"

  environment            = "production"
  allow_secrets_in_state = var.allow_secrets_in_state

  cloudflare_account_id = var.cloudflare_account_id
  zone = {
    name   = var.zone_name
    create = true
  }

  queues = {
    outbox = {}
  }

  waiver_evidence_lock_days = var.waiver_evidence_lock_days
  backup_expire_days        = 35

  hyperdrive          = var.hyperdrive
  hyperdrive_password = var.hyperdrive_password
  tokens              = var.tokens

  alert_email_destinations      = var.alert_email_destinations
  alert_webhook_destination_ids = var.alert_webhook_destination_ids

  custom_hostname_fallback = var.custom_hostname_fallback

  neon_project_id = var.neon_project_id
  neon_project = {
    name = "tidegrid-production"
    # The hosting plan's 30-day point-in-time restore window.
    history_retention_seconds = 2592000
    # Hosting plan production proposal: Azure East US 2, 0.25 to 2 CU, and
    # scale to zero disabled (-1 means never suspend).
    region_id               = "azure-eastus2"
    min_cu                  = 0.25
    max_cu                  = 2
    suspend_timeout_seconds = -1
  }
  neon_branches = {}
}
