terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    kubernetes = {
      # Needed to manage the aws-auth ConfigMap so the EKS node role can actually
      # authenticate against the cluster — see architecture-decisions.md §3.5.
      source  = "hashicorp/kubernetes"
      version = "~> 2.31"
    }
  }
}
