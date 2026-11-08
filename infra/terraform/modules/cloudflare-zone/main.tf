# One Cloudflare zone. A zone that already exists is imported with an import
# block in the environment root, never recreated.
resource "cloudflare_zone" "this" {
  account = {
    id = var.account_id
  }
  name = var.zone_name
  type = var.zone_type

  lifecycle {
    # Destroying a zone takes every hostname under it offline.
    prevent_destroy = true
  }
}
