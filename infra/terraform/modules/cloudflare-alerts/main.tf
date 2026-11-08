locals {
  email    = [for address in var.email_destinations : { id = address }]
  webhooks = [for id in var.webhook_destination_ids : { id = id }]
}

resource "cloudflare_notification_policy" "this" {
  for_each = var.policies

  account_id  = var.account_id
  name        = "${var.name_prefix}-${each.key}"
  description = each.value.description
  alert_type  = each.value.alert_type
  enabled     = true

  mechanisms = {
    email    = length(local.email) > 0 ? local.email : null
    webhooks = length(local.webhooks) > 0 ? local.webhooks : null
  }

  filters = each.value.zone_scoped || each.value.incident_impact != null ? {
    zones           = each.value.zone_scoped ? var.zone_ids : null
    incident_impact = each.value.incident_impact
  } : null

  lifecycle {
    precondition {
      condition     = length(local.email) + length(local.webhooks) > 0
      error_message = "An alert needs at least one email or webhook destination."
    }
  }
}
