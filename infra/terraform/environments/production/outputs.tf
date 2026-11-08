output "wrangler_inputs" {
  description = "Identifiers for this environment's Wrangler configuration. No secret values."
  value = {
    queue_names                     = module.environment.queue_names
    dead_letter_queue_names         = module.environment.dead_letter_queue_names
    bucket_names                    = module.environment.bucket_names
    hyperdrive_id                   = module.environment.hyperdrive_id
    custom_hostname_fallback_origin = module.environment.custom_hostname_fallback_origin
  }
}

output "zone" {
  description = "Zone id and, for a zone Terraform created, its name servers. Keep both out of the repository."
  value = {
    id           = module.environment.zone_id
    name_servers = module.environment.zone_name_servers
  }
}

output "neon" {
  description = "Neon project and long-lived branch ids."
  value = {
    project_id = module.environment.neon_project_id
    branch_ids = module.environment.neon_branch_ids
  }
}
