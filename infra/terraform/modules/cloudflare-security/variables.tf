variable "account_id" {
  description = "Cloudflare account that owns the Turnstile widget."
  type        = string
}

variable "zone_id" {
  description = "The product zone the firewall and rate limit rules attach to."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for names, for example tidegrid-production."
  type        = string
}

variable "manage_zone_rules" {
  description = <<-EOT
    Whether OpenTofu owns this zone's custom firewall and rate limit rules.
    Each zone has one ruleset per phase, so owning it replaces any rules made
    in the dashboard. Production (its own zone) sets true. Staging shares the
    preview's tidegrid.us zone and leaves it false, so a staging plan never
    changes the live preview's firewall.
  EOT
  type        = bool
}

variable "api_host" {
  description = "The API's hostname, for example api.tidegrid.us. Needed only when manage_zone_rules is true."
  type        = string
  default     = null

  validation {
    condition     = !var.manage_zone_rules || try(length(var.api_host) > 0, false)
    error_message = "api_host is required when manage_zone_rules is true."
  }
}

variable "rate_limits" {
  description = <<-EOT
    Per client address limits at Cloudflare's edge, on top of the Worker's own
    limiters and the database's. A request over the limit is blocked for
    mitigation_timeout seconds. The number of rules and the periods allowed
    depend on the zone's plan: Free allows one rule with a 10 second period,
    Pro two, Business five. Periods and timeouts must be values the plan
    offers (10, 60, 120, 300, 600, 3600 seconds).
  EOT
  type = map(object({
    expression          = string
    requests_per_period = number
    period              = number
    mitigation_timeout  = number
  }))
}

variable "turnstile_domains" {
  description = <<-EOT
    Hostnames where the guest site shows the Turnstile check (the guest
    site's own domain and the operators' booking hosts). Empty means no
    widget is created here.
  EOT
  type        = list(string)
  default     = []
}

variable "create_turnstile_widget" {
  description = <<-EOT
    The widget's secret key is returned by Cloudflare and kept in OpenTofu
    state, which the hosting plan forbids unless the owner allows secrets in
    state (D1). The environment passes allow_secrets_in_state. While false,
    the owner creates the widget in the dashboard and stores its secret as
    the API's TURNSTILE_SECRET_KEY.
  EOT
  type        = bool
  default     = false
}
