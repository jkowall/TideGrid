terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.18"
    }
  }

  # Remote state only. The backend's settings (bucket, key, region, the KMS
  # key, use_lockfile = true, encrypt = true) come from a backend.hcl file in
  # the owner's private location, passed as
  # terraform init -backend-config=<that file>. The repository never holds
  # state or backend.hcl. CI runs init with -backend=false and never reads
  # state. See infra/terraform/README.md.
  backend "s3" {}
}

# Credentials come from the environment of whoever runs the plan:
# CLOUDFLARE_API_TOKEN for Cloudflare and NEON_API_KEY for Neon. They are
# never variables, files, or outputs here.
provider "cloudflare" {}

provider "neon" {}
