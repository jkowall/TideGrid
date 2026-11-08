variable "account_id" {
  description = "Cloudflare account that owns the queues."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for every queue name, for example tidegrid-staging."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,40}$", var.name_prefix))
    error_message = "name_prefix must be lowercase letters, digits, and hyphens."
  }
}

variable "queues" {
  description = <<-EOT
    Queues keyed by purpose. Each queue gets a dead letter queue named
    <prefix>-<key>-dlq unless dead_letter is false. Consumers, batch size,
    retries, and the dead letter binding are declared in the async Worker's
    Wrangler configuration, not here.
  EOT
  type = map(object({
    dead_letter                   = optional(bool, true)
    delivery_delay_seconds        = optional(number, 0)
    message_retention_seconds     = optional(number, 345600)
    dead_letter_retention_seconds = optional(number, 1209600)
  }))
  default = {
    outbox = {}
  }

  validation {
    condition     = alltrue([for key in keys(var.queues) : can(regex("^[a-z0-9][a-z0-9-]{0,20}$", key))])
    error_message = "Queue keys must be short lowercase names."
  }

  validation {
    condition = alltrue(flatten([
      for queue in values(var.queues) : [
        queue.message_retention_seconds >= 60 && queue.message_retention_seconds <= 1209600,
        queue.dead_letter_retention_seconds >= 60 && queue.dead_letter_retention_seconds <= 1209600,
      ]
    ]))
    error_message = "Retention must be between 60 seconds and 14 days."
  }
}
