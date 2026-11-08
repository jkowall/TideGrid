terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.1"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "= 0.18.0"
    }
  }
}
