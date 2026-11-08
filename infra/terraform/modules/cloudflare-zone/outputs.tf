output "zone_id" {
  description = "Zone identifier, for routes, DNS records, and Wrangler configuration."
  value       = cloudflare_zone.this.id
}

output "name_servers" {
  description = "Name servers Cloudflare assigned to the zone."
  value       = cloudflare_zone.this.name_servers
}
