output "policy_ids" {
  description = "Notification policy ids by key."
  value       = { for key, policy in cloudflare_notification_policy.this : key => policy.id }
}
