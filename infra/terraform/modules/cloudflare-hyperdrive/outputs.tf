output "hyperdrive_id" {
  description = "Hyperdrive configuration id, for the API Worker's hyperdrive binding."
  value       = cloudflare_hyperdrive_config.this.id
}
