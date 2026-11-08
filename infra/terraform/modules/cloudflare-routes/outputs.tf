output "route_ids" {
  description = "Route identifiers by route key."
  value       = { for key, route in cloudflare_workers_route.this : key => route.id }
}
