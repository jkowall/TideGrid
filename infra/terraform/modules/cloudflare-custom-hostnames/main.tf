# Cloudflare for SaaS plumbing only. Each operator's custom hostname is created
# by TideGrid's hostname tooling at onboarding time, never by Terraform:
# operators must not create infrastructure (hosting plan). The guest Worker
# answers custom hostnames through a catch-all route or custom domain that
# Wrangler or the routes module owns, never both.
resource "cloudflare_dns_record" "fallback_origin" {
  zone_id = var.zone_id
  name    = var.fallback_record_name
  type    = "AAAA"
  # 100:: is the documented discard address used as an originless target when
  # a Worker answers every request.
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Cloudflare for SaaS fallback origin, served by the guest Worker. Managed by Terraform."
}

resource "cloudflare_custom_hostname_fallback_origin" "this" {
  zone_id = var.zone_id
  origin  = var.fallback_record_name

  depends_on = [cloudflare_dns_record.fallback_origin]
}
