locals {
  dead_letter_queues = { for key, queue in var.queues : key => queue if queue.dead_letter }
}

# PostgreSQL keeps the outbox as the source of truth. A queue message is only a
# delivery hint, so a lost or repeated message never loses or doubles an
# outcome (hosting plan, async delivery).
resource "cloudflare_queue" "main" {
  for_each = var.queues

  account_id = var.account_id
  queue_name = "${var.name_prefix}-${each.key}"

  settings = {
    delivery_delay           = each.value.delivery_delay_seconds
    message_retention_period = each.value.message_retention_seconds
  }
}

resource "cloudflare_queue" "dead_letter" {
  for_each = local.dead_letter_queues

  account_id = var.account_id
  queue_name = "${var.name_prefix}-${each.key}-dlq"

  settings = {
    message_retention_period = each.value.dead_letter_retention_seconds
  }
}
