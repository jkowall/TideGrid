# Values come from TF_VAR_ environment variables loaded from the owner's
# private location. None of them is committed.

variable "allow_secrets_in_state" {
  description = "See modules/environment. Stays false until the owner decides otherwise."
  type        = bool
  default     = false
}

variable "cloudflare_account_id" {
  description = "The existing Cloudflare account."
  type        = string
}

variable "zone_id" {
  description = "Zone id of tidegrid.us."
  type        = string
}

variable "neon_project_id" {
  description = "The nonproduction Neon project."
  type        = string
}

variable "hyperdrive" {
  description = "Direct endpoint of the staging branch, once it exists. Used only with allow_secrets_in_state."
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
  description = "Scoped tokens for staging. Used only with allow_secrets_in_state."
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
