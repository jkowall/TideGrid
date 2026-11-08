resource "cloudflare_workers_route" "this" {
  for_each = var.routes

  zone_id = var.zone_id
  pattern = each.value.pattern
  script  = each.value.script
}
