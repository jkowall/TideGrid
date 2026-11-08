output "fallback_origin" {
  description = "Hostname operators point their CNAME at."
  value       = cloudflare_custom_hostname_fallback_origin.this.origin
}
