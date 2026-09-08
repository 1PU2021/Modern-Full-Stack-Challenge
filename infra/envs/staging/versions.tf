terraform {
  # Same floor as envs/prod — >= 1.10 for S3-native state locking (use_lockfile).
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      # Needed by infra/modules/eks — the OIDC provider setup uses a
      # tls_certificate data source to fetch the cluster's issuer thumbprint.
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
