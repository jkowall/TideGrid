# Cloudflare returns the token value once, at creation, and the provider keeps
# it in state. The environment roots create this module only when
# allow_secrets_in_state is true. The value is never an output of this module.
resource "cloudflare_account_token" "this" {
  for_each = var.tokens

  account_id = var.account_id
  name       = "${var.name_prefix}-${each.key}"
  expires_on = each.value.expires_on

  policies = [{
    effect            = "allow"
    permission_groups = [for id in each.value.permission_group_ids : { id = id }]
    resources         = jsonencode(each.value.resources)
  }]

  condition = each.value.allowed_cidrs == null ? null : {
    request_ip = {
      in = each.value.allowed_cidrs
    }
  }
}
