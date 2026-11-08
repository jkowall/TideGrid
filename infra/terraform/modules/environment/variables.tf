variable "environment" {
  description = "Environment name. Every resource name starts with tidegrid-<environment>."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "allow_secrets_in_state" {
  description = <<-EOT
    The hosting plan says Terraform state holds no secret values. Three
    resources cannot meet that: a Hyperdrive configuration (its origin
    password), an account API token (its value), and a new Neon project (its
    default role password). They are created only when this is true, which
    needs the owner's decision. While it is false, those three stay as they
    are made today, outside Terraform.
  EOT
  type        = bool
  default     = false
}

# Cloudflare ------------------------------------------------------------------

variable "cloudflare_account_id" {
  description = "Cloudflare account for this environment. Supplied at plan time, never committed."
  type        = string
}

variable "zone" {
  description = <<-EOT
    The product zone. create = true makes Terraform own the zone (production,
    in its dedicated account). create = false only reads the existing zone id
    (staging on the shared tidegrid.us zone), so a staging plan can never touch
    a live zone's settings.
  EOT
  type = object({
    name        = string
    create      = bool
    existing_id = optional(string)
  })

  validation {
    condition     = var.zone.create || var.zone.existing_id != null
    error_message = "Set zone.existing_id when zone.create is false."
  }
}

variable "routes" {
  description = "Worker routes Terraform owns. See the routes module: never a route Wrangler also declares."
  type = map(object({
    pattern = string
    script  = string
  }))
  default = {}
}

variable "queues" {
  description = "Queues and their dead letter queues. See the queues module."
  type = map(object({
    dead_letter                   = optional(bool, true)
    delivery_delay_seconds        = optional(number, 0)
    message_retention_seconds     = optional(number, 345600)
    dead_letter_retention_seconds = optional(number, 1209600)
  }))
  default = {
    outbox = {}
  }
}

variable "waiver_evidence_lock_days" {
  description = <<-EOT
    How long each signed waiver PDF is locked against change or deletion. No
    default: the retention period is a legal decision the owner makes.
  EOT
  type        = number

  validation {
    condition     = var.waiver_evidence_lock_days >= 1
    error_message = "waiver_evidence_lock_days must be at least one day."
  }
}

variable "backup_expire_days" {
  description = "Days a logical backup is kept in the backups bucket before it is deleted."
  type        = number
  default     = 35
}

variable "hyperdrive" {
  description = "Neon direct endpoint for Hyperdrive. Used only when allow_secrets_in_state is true."
  type = object({
    host             = string
    database         = string
    user             = string
    port             = optional(number, 5432)
    connection_limit = optional(number)
  })
  default = null
}

variable "hyperdrive_password" {
  description = "Origin role password for Hyperdrive. TF_VAR_ only, from the owner's private location."
  type        = string
  default     = null
  sensitive   = true
}

variable "tokens" {
  description = "Scoped account tokens. Used only when allow_secrets_in_state is true. See the tokens module."
  type = map(object({
    permission_group_ids = list(string)
    resources            = map(string)
    expires_on           = string
    allowed_cidrs        = optional(list(string))
  }))
  default = {}
}

variable "alert_email_destinations" {
  description = "Addresses that receive Cloudflare alerts. Supplied at plan time, never committed."
  type        = list(string)
  default     = []
}

variable "alert_webhook_destination_ids" {
  description = "Webhook destination ids (for example a paging service) set up in Cloudflare."
  type        = list(string)
  default     = []
}

variable "custom_hostname_fallback" {
  description = "Fallback origin hostname for Cloudflare for SaaS, or null to leave SaaS plumbing out."
  type        = string
  default     = null
}

# Neon ------------------------------------------------------------------------

variable "neon_project_id" {
  description = "Existing Neon project id. Used when neon_project is null or secrets in state are not allowed."
  type        = string
  default     = null
}

variable "neon_project" {
  description = "Settings for a Neon project Terraform creates. See the neon module."
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
}

variable "neon_branches" {
  description = "Long-lived Neon branches and their compute. See the neon module."
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
