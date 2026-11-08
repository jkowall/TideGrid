variable "zone_id" {
  description = "The SaaS zone that holds the fallback origin."
  type        = string
}

variable "fallback_record_name" {
  description = <<-EOT
    Name of the fallback origin record inside the zone, for example
    customers.<domain>. Operators point their CNAME at this name.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.fallback_record_name))
    error_message = "fallback_record_name must be a full lowercase hostname inside the zone."
  }
}
