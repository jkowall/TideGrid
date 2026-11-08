# One TideGrid environment: the Cloudflare resources the hosting plan gives to
# Terraform, plus the Neon side. Worker scripts, versions, and bindings stay
# with Wrangler; this module only outputs the identifiers Wrangler needs.

locals {
  prefix = "tidegrid-${var.environment}"

  manage_neon_project = var.allow_secrets_in_state && var.neon_project != null
}

module "zone" {
  source = "../cloudflare-zone"
  count  = var.zone.create ? 1 : 0

  account_id = var.cloudflare_account_id
  zone_name  = var.zone.name
}

locals {
  zone_id = var.zone.create ? module.zone[0].zone_id : var.zone.existing_id
}

module "routes" {
  source = "../cloudflare-routes"

  zone_id = local.zone_id
  routes  = var.routes
}

module "queues" {
  source = "../cloudflare-queues"

  account_id  = var.cloudflare_account_id
  name_prefix = local.prefix
  queues      = var.queues
}

module "r2" {
  source = "../cloudflare-r2"

  account_id  = var.cloudflare_account_id
  name_prefix = local.prefix
  buckets = {
    # Signed waiver PDFs, content-addressed, under object lock.
    waiver-evidence = { lock_days = var.waiver_evidence_lock_days }
    # Operator-approved brand assets.
    brand-assets = {}
    # Generated documents, such as exports.
    documents = {}
    # Encrypted daily pg_dump files. The decryption key lives outside both
    # Neon and this Cloudflare account (hosting plan, backup and recovery).
    backups = { expire_days = var.backup_expire_days }
  }
}

module "hyperdrive" {
  source = "../cloudflare-hyperdrive"
  count  = var.allow_secrets_in_state && var.hyperdrive != null ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = "${local.prefix}-db"
  origin = {
    host     = var.hyperdrive.host
    port     = var.hyperdrive.port
    database = var.hyperdrive.database
    user     = var.hyperdrive.user
  }
  origin_password         = var.hyperdrive_password
  origin_connection_limit = var.hyperdrive.connection_limit
}

module "tokens" {
  source = "../cloudflare-tokens"
  count  = var.allow_secrets_in_state ? 1 : 0

  account_id  = var.cloudflare_account_id
  name_prefix = local.prefix
  tokens      = var.tokens
}

module "alerts" {
  source = "../cloudflare-alerts"
  count  = length(var.alert_email_destinations) + length(var.alert_webhook_destination_ids) > 0 ? 1 : 0

  account_id              = var.cloudflare_account_id
  name_prefix             = local.prefix
  email_destinations      = var.alert_email_destinations
  webhook_destination_ids = var.alert_webhook_destination_ids
  zone_ids                = [local.zone_id]
}

module "custom_hostnames" {
  source = "../cloudflare-custom-hostnames"
  count  = var.custom_hostname_fallback == null ? 0 : 1

  zone_id              = local.zone_id
  fallback_record_name = var.custom_hostname_fallback
}

module "neon" {
  source = "../neon"

  manage_project = local.manage_neon_project
  project_id     = local.manage_neon_project ? null : var.neon_project_id
  project        = local.manage_neon_project ? var.neon_project : null
  branches       = var.neon_branches
}
