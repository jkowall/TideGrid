# The Neon side of TideGrid's infrastructure: the project (optional, see
# manage_project), long-lived branches, and their compute policy.
#
# This module never creates a Neon role. The runtime role tidegrid_app comes
# only from migration 0001 in SQL, and the owner role comes with the project.
# Never add a neon_role resource here.

resource "neon_project" "this" {
  count = var.manage_project ? 1 : 0

  name                      = var.project.name
  org_id                    = var.project.org_id
  region_id                 = var.project.region_id
  pg_version                = var.project.pg_version
  history_retention_seconds = var.project.history_retention_seconds
  default_branch_protected  = true

  branch {
    name          = var.project.default_branch_name
    database_name = var.project.database_name
    role_name     = var.project.owner_role_name
  }

  primary_compute {
    autoscaling_limit_min_cu = var.project.min_cu
    autoscaling_limit_max_cu = var.project.max_cu
    suspend_timeout_seconds  = var.project.suspend_timeout_seconds
  }

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  project_id = var.manage_project ? neon_project.this[0].id : var.project_id
  computes   = { for name, branch in var.branches : name => branch.compute if branch.compute != null }
}

resource "neon_branch" "this" {
  for_each = var.branches

  project_id = local.project_id
  name       = each.key
  parent_id  = each.value.parent_id
  protected  = each.value.protected ? "yes" : "no"
}

resource "neon_endpoint" "this" {
  for_each = local.computes

  project_id               = local.project_id
  branch_id                = neon_branch.this[each.key].id
  type                     = "read_write"
  autoscaling_limit_min_cu = each.value.min_cu
  autoscaling_limit_max_cu = each.value.max_cu
  suspend_timeout_seconds  = each.value.suspend_timeout_seconds
}
