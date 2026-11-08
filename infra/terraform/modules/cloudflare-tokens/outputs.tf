output "token_ids" {
  description = "Token ids by key. Token values are deliberately not output."
  value       = { for key, token in cloudflare_account_token.this : key => token.id }
}
