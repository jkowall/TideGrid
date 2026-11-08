output "queue_names" {
  description = "Queue names by key, for the async Worker's Wrangler configuration."
  value       = { for key, queue in cloudflare_queue.main : key => queue.queue_name }
}

output "dead_letter_queue_names" {
  description = "Dead letter queue names by key."
  value       = { for key, queue in cloudflare_queue.dead_letter : key => queue.queue_name }
}

output "queue_ids" {
  description = "Queue identifiers by key."
  value       = { for key, queue in cloudflare_queue.main : key => queue.queue_id }
}
