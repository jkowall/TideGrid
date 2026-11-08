# Identifiers for this environment. None of these is a secret. The zone id
# stays out of the repository; Wrangler custom domains do not need it.

output "zone_id" {
  description = "Zone id."
  value       = local.zone_id
}

output "zone_name_servers" {
  description = "Name servers of a zone Terraform created, for delegating the domain. Null otherwise."
  value       = one(module.zone[*].name_servers)
}

output "queue_names" {
  description = "Queue names by key, for queues.producers and queues.consumers."
  value       = module.queues.queue_names
}

output "dead_letter_queue_names" {
  description = "Dead letter queue names by key, for each consumer's dead_letter_queue."
  value       = module.queues.dead_letter_queue_names
}

output "bucket_names" {
  description = "R2 bucket names by key, for r2_buckets bindings."
  value       = module.r2.bucket_names
}

output "hyperdrive_id" {
  description = "Hyperdrive configuration id, or null while it stays outside Terraform."
  value       = one(module.hyperdrive[*].hyperdrive_id)
}

output "token_ids" {
  description = "Scoped token ids. Values are never output."
  value       = one(module.tokens[*].token_ids)
}

output "custom_hostname_fallback_origin" {
  description = "Hostname operators point their CNAME at, or null."
  value       = one(module.custom_hostnames[*].fallback_origin)
}

output "neon_project_id" {
  description = "Neon project id."
  value       = module.neon.project_id
}

output "neon_branch_ids" {
  description = "Long-lived Neon branch ids by name."
  value       = module.neon.branch_ids
}
