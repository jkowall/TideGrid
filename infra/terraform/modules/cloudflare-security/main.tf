# Edge protections for one environment (W3-OPS-4): custom firewall rules,
# rate limits, and the Turnstile widget. The Worker keeps its own limiters
# (AUTH_RATE_LIMITER, PUBLIC_RATE_LIMITER), its 16 KiB body cap, its origin
# checks, and the database's limits; these rules stop abusive traffic before
# it reaches a Worker at all.

locals {
  api = "http.host eq \"${var.api_host}\""
}

resource "cloudflare_ruleset" "firewall" {
  count = var.manage_zone_rules ? 1 : 0

  zone_id     = var.zone_id
  name        = "${var.name_prefix}-firewall"
  description = "TideGrid custom firewall rules (W3-OPS-4). Managed by Terraform."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "api_methods"
      description = "The API answers only these methods"
      expression  = "${local.api} and not http.request.method in {\"GET\" \"HEAD\" \"POST\" \"PUT\" \"PATCH\" \"DELETE\" \"OPTIONS\"}"
      action      = "block"
      enabled     = true
    },
    {
      ref         = "api_paths"
      description = "The API serves only /v1/ paths (no admin panels, dotfiles, or scanners)"
      expression  = "${local.api} and not starts_with(http.request.uri.path, \"/v1/\")"
      action      = "block"
      enabled     = true
    },
    {
      ref         = "api_traversal"
      description = "No encoded or literal path traversal"
      expression  = "${local.api} and (http.request.uri.path contains \"..\" or lower(http.request.uri.path) contains \"%2e%2e\")"
      action      = "block"
      enabled     = true
    },
    {
      ref         = "fake_routes"
      description = "The demo's fake provider and mailbox routes never answer in a deployed environment"
      expression  = "${local.api} and (starts_with(http.request.uri.path, \"/v1/fake-provider/\") or starts_with(http.request.uri.path, \"/v1/fake-email/\"))"
      action      = "block"
      enabled     = true
    },
    {
      ref         = "public_writes_no_agent"
      description = "Public writes need a user agent (browsers and the app send one); verified bots aside. The Stripe webhook is under /v1/webhooks/ and unaffected"
      expression  = "${local.api} and starts_with(http.request.uri.path, \"/v1/public/\") and http.request.method eq \"POST\" and http.user_agent eq \"\" and not cf.client.bot"
      action      = "block"
      enabled     = true
    },
  ]
}

resource "cloudflare_ruleset" "rate_limits" {
  count = var.manage_zone_rules && length(var.rate_limits) > 0 ? 1 : 0

  zone_id     = var.zone_id
  name        = "${var.name_prefix}-rate-limits"
  description = "TideGrid edge rate limits (W3-OPS-4). Managed by Terraform."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    for key, limit in var.rate_limits : {
      ref         = key
      description = "Rate limit: ${key}"
      expression  = limit.expression
      action      = "block"
      enabled     = true
      ratelimit = {
        # Per client address, counted in each Cloudflare location.
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = limit.period
        requests_per_period = limit.requests_per_period
        mitigation_timeout  = limit.mitigation_timeout
      }
    }
  ]
}

# The guest site's human check on public forms that write (checkout, the
# manage link request, the dock lookup). Managed mode: most people never see
# a puzzle. Created here only when secrets may sit in state (D1).
resource "cloudflare_turnstile_widget" "guest" {
  count = var.create_turnstile_widget && length(var.turnstile_domains) > 0 ? 1 : 0

  account_id = var.account_id
  name       = "${var.name_prefix}-guest"
  domains    = var.turnstile_domains
  mode       = "managed"
}
