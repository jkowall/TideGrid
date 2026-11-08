variable "zone_id" {
  description = "Zone the routes belong to."
  type        = string
}

variable "routes" {
  description = <<-EOT
    Worker routes that Terraform owns, keyed by a stable name. A route listed
    here must not also appear in any Wrangler configuration: Terraform and
    Wrangler never manage the same route. Custom domains that Wrangler declares
    today stay with Wrangler.
  EOT
  type = map(object({
    pattern = string
    script  = string
  }))
  default = {}
}
