output "turnstile_site_key" {
  description = "The widget's public site key, for the guest site's TURNSTILE_SITE_KEY. Null when the widget is made in the dashboard. The secret key is never an output."
  value       = one(cloudflare_turnstile_widget.guest[*].sitekey)
}

output "firewall_ruleset_id" {
  description = "The zone's custom firewall ruleset, or null when Terraform does not own it."
  value       = one(cloudflare_ruleset.firewall[*].id)
}

output "rate_limit_ruleset_id" {
  description = "The zone's rate limit ruleset, or null when Terraform does not own it."
  value       = one(cloudflare_ruleset.rate_limits[*].id)
}
