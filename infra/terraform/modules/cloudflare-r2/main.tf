locals {
  locked   = { for key, bucket in var.buckets : key => bucket if bucket.lock_days != null }
  expiring = { for key, bucket in var.buckets : key => bucket if bucket.expire_days != null }
}

resource "cloudflare_r2_bucket" "this" {
  for_each = var.buckets

  account_id = var.account_id
  name       = "${var.name_prefix}-${each.key}"
  location   = var.location

  lifecycle {
    # Waiver evidence and backups must never go with a stray destroy.
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lock" "this" {
  for_each = local.locked

  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this[each.key].name
  rules = [{
    id      = "retain-every-object"
    enabled = true
    prefix  = ""
    condition = {
      type            = "Age"
      max_age_seconds = each.value.lock_days * 86400
    }
  }]

  lifecycle {
    # Removing the lock on waiver evidence needs a deliberate code change.
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lifecycle" "this" {
  for_each = local.expiring

  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this[each.key].name
  rules = [{
    id      = "expire-old-objects"
    enabled = true
    conditions = {
      prefix = ""
    }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = each.value.expire_days * 86400
      }
    }
    abort_multipart_uploads_transition = {
      condition = {
        type    = "Age"
        max_age = 7 * 86400
      }
    }
  }]
}
