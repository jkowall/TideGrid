variable "manage_project" {
  description = <<-EOT
    true creates and owns the Neon project here. Creating a project makes Neon
    return the default role's password, which the provider stores in state, so
    the environment roots pass true only when allow_secrets_in_state is true.
    false points at an existing project by project_id.
  EOT
  type        = bool
  default     = false
}

variable "project_id" {
  description = "Existing Neon project id, used when manage_project is false. Supplied at plan time."
  type        = string
  default     = null

  validation {
    condition     = var.manage_project || var.project_id != null
    error_message = "Set project_id when manage_project is false."
  }
}

variable "project" {
  description = <<-EOT
    Settings for a project this module creates. history_retention_seconds is
    the point-in-time restore window. The hosting plan sets 30 days for
    production; the free and Launch plans cap it lower.
  EOT
  type = object({
    name                      = string
    org_id                    = optional(string)
    region_id                 = optional(string, "aws-us-east-2")
    pg_version                = optional(number, 17)
    history_retention_seconds = optional(number, 86400)
    default_branch_name       = optional(string, "main")
    database_name             = optional(string, "tidegrid")
    owner_role_name           = optional(string, "tidegrid_owner")
    min_cu                    = optional(number, 0.25)
    max_cu                    = optional(number, 1)
    suspend_timeout_seconds   = optional(number, 300)
  })
  default = null

  validation {
    condition     = !var.manage_project || var.project != null
    error_message = "manage_project needs the project settings."
  }

  validation {
    condition     = var.project == null || try(var.project.owner_role_name != "tidegrid_app", true)
    error_message = "tidegrid_app is created only by migration 0001, never as a Neon role."
  }

  validation {
    condition     = var.project == null || try(var.project.history_retention_seconds >= 0 && var.project.history_retention_seconds <= 2592000, true)
    error_message = "history_retention_seconds must be between 0 and 30 days."
  }
}

variable "branches" {
  description = <<-EOT
    Long-lived branches besides the default branch, keyed by branch name, for
    example a staging branch. Expiring per-PR branches stay with the database
    package's neon:branch tool, not Terraform. compute adds a read-write
    endpoint with its own autoscaling and scale-to-zero settings.
  EOT
  type = map(object({
    parent_id = optional(string)
    protected = optional(bool, false)
    compute = optional(object({
      min_cu                  = optional(number, 0.25)
      max_cu                  = optional(number, 1)
      suspend_timeout_seconds = optional(number, 300)
    }))
  }))
  default = {}
}
