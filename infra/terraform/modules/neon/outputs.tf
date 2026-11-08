output "project_id" {
  description = "Neon project id."
  value       = local.project_id
}

output "default_branch_id" {
  description = "Default branch id of a project this module created, else null."
  value       = var.manage_project ? neon_project.this[0].default_branch_id : null
}

output "branch_ids" {
  description = "Long-lived branch ids by name."
  value       = { for name, branch in neon_branch.this : name => branch.id }
}

output "endpoint_hosts" {
  description = <<-EOT
    Direct (unpooled) endpoint host of each branch with compute. Hosts stay out
    of the repository and logs; read them from state when wiring Hyperdrive.
  EOT
  value       = { for name, endpoint in neon_endpoint.this : name => endpoint.host }
  sensitive   = true
}
