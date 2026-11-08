variable "account_id" {
  description = "Cloudflare account the tokens belong to."
  type        = string
}

variable "tokens" {
  description = <<-EOT
    Account-owned API tokens keyed by job, each scoped to the smallest set of
    permission groups and resources it needs. permission_group_ids are the
    Cloudflare permission group ids (public, not secret). resources maps a
    Cloudflare resource string, such as
    com.cloudflare.api.account.<account id>, to "*". expires_on is an RFC 3339
    time; every token must expire so a leaked one dies on its own.
  EOT
  type = map(object({
    permission_group_ids = list(string)
    resources            = map(string)
    expires_on           = string
    allowed_cidrs        = optional(list(string))
  }))
  default = {}

  validation {
    condition     = alltrue([for token in values(var.tokens) : length(token.permission_group_ids) > 0 && length(token.resources) > 0])
    error_message = "Each token needs at least one permission group and one resource."
  }

  validation {
    condition     = alltrue([for token in values(var.tokens) : !contains(values(token.resources), "") && can(timeadd(token.expires_on, "0s"))])
    error_message = "Each token needs an RFC 3339 expires_on and non-empty resource values."
  }
}

variable "name_prefix" {
  description = "Prefix for token names, for example tidegrid-staging."
  type        = string
}
