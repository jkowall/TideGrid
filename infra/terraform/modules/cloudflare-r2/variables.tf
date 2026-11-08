variable "account_id" {
  description = "Cloudflare account that owns the buckets."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for every bucket name, for example tidegrid-staging."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,40}$", var.name_prefix))
    error_message = "name_prefix must be lowercase letters, digits, and hyphens."
  }
}

variable "location" {
  description = "Location hint for new buckets. enam is eastern North America."
  type        = string
  default     = "enam"
}

variable "buckets" {
  description = <<-EOT
    Private buckets keyed by purpose. lock_days sets an object lock rule on
    every object for that many days (waiver evidence). expire_days deletes
    objects after that many days (backups). Leave either null to skip it.
    Buckets are always private: no public access or r2.dev URL is set here.
  EOT
  type = map(object({
    lock_days   = optional(number)
    expire_days = optional(number)
  }))

  validation {
    condition     = alltrue([for key in keys(var.buckets) : can(regex("^[a-z0-9][a-z0-9-]{0,20}$", key))])
    error_message = "Bucket keys must be short lowercase names."
  }

  validation {
    condition = alltrue([
      for bucket in values(var.buckets) :
      bucket.lock_days == null || bucket.expire_days == null || try(bucket.expire_days > bucket.lock_days, false)
    ])
    error_message = "expire_days must be longer than lock_days, or a lifecycle rule would fight the lock."
  }

  validation {
    condition = alltrue(flatten([
      for bucket in values(var.buckets) : [
        bucket.lock_days == null || try(bucket.lock_days >= 1 && floor(bucket.lock_days) == bucket.lock_days, false),
        bucket.expire_days == null || try(bucket.expire_days >= 1 && floor(bucket.expire_days) == bucket.expire_days, false),
      ]
    ]))
    error_message = "lock_days and expire_days must be whole numbers of days."
  }
}
