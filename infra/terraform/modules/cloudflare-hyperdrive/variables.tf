variable "account_id" {
  description = "Cloudflare account that owns the Hyperdrive configuration."
  type        = string
}

variable "name" {
  description = "Hyperdrive configuration name, for example tidegrid-staging-db."
  type        = string
}

variable "origin" {
  description = <<-EOT
    The Neon direct, unpooled endpoint. Never the pooled (-pooler) host:
    Hyperdrive already pools, and stacking Neon's PgBouncer under it is ruled
    out by the hosting plan.
  EOT
  type = object({
    host     = string
    port     = optional(number, 5432)
    database = string
    user     = string
  })

  validation {
    condition     = !strcontains(var.origin.host, "-pooler")
    error_message = "Use Neon's direct endpoint, not the pooled -pooler host."
  }
}

variable "origin_password" {
  description = <<-EOT
    Password of the origin role. Passed only through TF_VAR_ from the owner's
    private location at plan time. Terraform stores it in state, so the
    environment roots create this module only when allow_secrets_in_state is
    true (see infra/terraform/README.md).
  EOT
  type        = string
  sensitive   = true
}

variable "origin_connection_limit" {
  description = "Upper bound on origin connections Hyperdrive opens. Null keeps Cloudflare's default."
  type        = number
  default     = null
}
