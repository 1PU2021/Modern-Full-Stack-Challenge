// This is a DELIBERATELY SEPARATE, one-time-run config — not one of the
// reusable modules under modules/. It solves Terraform's classic chicken-
// and-egg problem: you can't store a bucket's state inside a bucket that
// doesn't exist yet. So this config has NO backend block at all — it uses
// plain local state (a terraform.tfstate file right here in this folder)
// to create the one thing everything else's remote state depends on.
//
// Run this once, by whoever has an identity that doesn't itself depend on
// the thing being built — that's Caleb's CalebSysAdmin bootstrap user, not
// the terraform-execution chain (which needs this bucket to already exist
// before IT can even run `terraform init`).
//
// After this applies successfully, every other root module's backend.tf
// (like envs/prod) can point at this bucket and use it for real.

// Standard AWS provider block. Region is parameterized (not hardcoded)
// so this stays consistent with every other root module/env in the repo
// — per the project docs, that value should resolve to us-east-2, since
// the training account's admin_us_east_2_only policy on Caleb's IAM user
// enforces that region as a hard boundary, not just a convention.
provider "aws" {
  region = var.region
}

// Used to verify at plan/apply time that we're actually targeting the
// training account, not whatever identity happens to be the ambient
// default in the current shell. See the lifecycle precondition below.
data "aws_caller_identity" "current" {}

// Tags applied to every resource this config creates. ManagedBy/Module
// are fixed here so anyone auditing the account can immediately tell
// "this thing came from the bootstrap config" versus one of the
// reusable modules, without needing to already know the repo layout.
locals {
  common_tags = merge(var.tags, {
    ManagedBy = "terraform"
    Module    = "bootstrap"
  })
}

// The actual state bucket. Per the project's live-infra-identifiers doc,
// this should be created with bucket_name = "aug-final-prj-tf-bucket"
// (via var.bucket_name) — that name is already fixed by the team, not a
// placeholder, and it's already all-lowercase, which S3 requires.
resource "aws_s3_bucket" "tf_state" {
  bucket = var.bucket_name

  tags = merge(local.common_tags, {
    Name = var.bucket_name
  })

  // Hard stop if the resolved AWS identity isn't actually in the training
  // account. This is what would have caught the personal-account mistake
  // immediately instead of silently creating the bucket in the wrong
  // place — a lifecycle precondition fails the apply outright, unlike a
  // `check` block, which only warns and lets the run continue.
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "Refusing to apply: current AWS identity resolves to account ${data.aws_caller_identity.current.account_id}, not the training account (${var.expected_account_id}). Check AWS_PROFILE / credential chain before re-running."
    }
  }
}

// Versioning means a corrupted or bad state file isn't unrecoverable — you
// can roll back to the previous version. Cheap insurance for something this
// important.
resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

// Encryption at rest for the state file itself — state can contain sensitive
// values (like resource IDs, sometimes secrets if a provider is careless
// about it), so this isn't optional. AES256 (S3-managed keys) is enough here
// — a customer-managed KMS key is already used for Aurora where it actually
// matters most; adding one here too would be extra key management for
// limited extra benefit on a bucket that holds infra state, not app data.
resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

// Nothing about this bucket should ever be public. Belt-and-suspenders on
// top of the fact that nothing grants public access anyway.
resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

// With versioning on, every state write keeps the old version around
// forever unless something cleans it up. This expires old (noncurrent)
// versions after 90 days so the bucket doesn't grow unbounded — current
// version is never touched by this rule.
resource "aws_s3_bucket_lifecycle_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}
