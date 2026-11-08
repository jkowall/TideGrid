variable "account_id" {
  description = "Cloudflare account that owns the zone. Supplied at plan time, never committed."
  type        = string
}

variable "zone_name" {
  description = "Apex domain of the zone, for example the TideGrid product domain."
  type        = string
}

variable "zone_type" {
  description = "Cloudflare zone type. A full zone is the only type planned."
  type        = string
  default     = "full"

  validation {
    condition     = contains(["full", "partial", "secondary"], var.zone_type)
    error_message = "zone_type must be full, partial, or secondary."
  }
}
