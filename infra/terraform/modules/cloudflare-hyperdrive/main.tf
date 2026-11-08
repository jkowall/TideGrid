resource "cloudflare_hyperdrive_config" "this" {
  account_id = var.account_id
  name       = var.name

  origin = {
    scheme   = "postgres"
    host     = var.origin.host
    port     = var.origin.port
    database = var.origin.database
    user     = var.origin.user
    password = var.origin_password
  }

  # Query caching stays off. Tenant authorization, availability, holds,
  # bookings, and money all need read-after-write (hosting plan). This is not
  # a variable on purpose.
  caching = {
    disabled = true
  }

  origin_connection_limit = var.origin_connection_limit
}
