# Values come from TF_VAR_ environment variables loaded from the owner's
# private location. None of them is committed.

variable "allow_secrets_in_state" {
  description = "See modules/environment. Stays false until the owner decides otherwise."
  type        = bool
  default     = false
}

variable "cloudflare_account_id" {
  description = "The dedicated production Cloudflare account."
  type        = string
}

variable "zone_name" {
  description = "The production product zone."
  type        = string
}

variable "waiver_evidence_lock_days" {
  description = "Waiver evidence lock period. A legal decision; no default."
  type        = number
}

variable "neon_project_id" {
  description = "Existing production Neon project, used while allow_secrets_in_state is false."
  type        = string
  default     = null
}

variable "hyperdrive" {
  description = "Direct endpoint of the production root branch. Used only with allow_secrets_in_state."
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
  description = "Origin role password for Hyperdrive."
  type        = string
  default     = null
  sensitive   = true
}

variable "tokens" {
  description = "Scoped tokens for production. Used only with allow_secrets_in_state."
  type = map(object({
    permission_group_ids = list(string)
    resources            = map(string)
    expires_on           = string
    allowed_cidrs        = optional(list(string))
  }))
  default = {}
}

variable "alert_email_destinations" {
  description = "Addresses for Cloudflare alerts."
  type        = list(string)
  default     = []
}

variable "alert_webhook_destination_ids" {
  description = "Paging webhook destination ids, once the paging provider is chosen."
  type        = list(string)
  default     = []
}

variable "custom_hostname_fallback" {
  description = "Cloudflare for SaaS fallback origin hostname, or null until operator domains attach."
  type        = string
  default     = null
}
