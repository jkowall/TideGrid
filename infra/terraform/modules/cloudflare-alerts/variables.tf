variable "account_id" {
  description = "Cloudflare account the notification policies belong to."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for policy names, for example tidegrid-production."
  type        = string
}

variable "email_destinations" {
  description = "Email addresses that receive the alerts. Supplied at plan time, never committed."
  type        = list(string)
  default     = []
}

variable "webhook_destination_ids" {
  description = "Ids of webhook destinations already set up in Cloudflare (for example a paging service)."
  type        = list(string)
  default     = []
}

variable "zone_ids" {
  description = "Zones the certificate alerts watch."
  type        = list(string)
  default     = []
}

variable "policies" {
  description = <<-EOT
    Notification policies keyed by name. Only the filters below are wired;
    add more when a policy needs them. Application signals (outbox age, DLQ
    depth, the email account fault) belong to the observability goal, not to
    Cloudflare notifications.
  EOT
  type = map(object({
    alert_type      = string
    description     = string
    zone_scoped     = optional(bool, false)
    incident_impact = optional(list(string))
  }))
  default = {
    certificates = {
      alert_type  = "universal_ssl_event_type"
      description = "Edge certificate issuance, renewal, or validation problems on TideGrid zones."
      zone_scoped = true
    }
    cloudflare-incidents = {
      alert_type      = "incident_alert"
      description     = "Major or critical Cloudflare incidents."
      incident_impact = ["INCIDENT_IMPACT_MAJOR", "INCIDENT_IMPACT_CRITICAL"]
    }
  }
}
