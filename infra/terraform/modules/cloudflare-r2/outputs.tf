output "bucket_names" {
  description = "Bucket names by key, for Wrangler r2_buckets bindings."
  value       = { for key, bucket in cloudflare_r2_bucket.this : key => bucket.name }
}
