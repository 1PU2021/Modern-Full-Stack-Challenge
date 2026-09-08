// The bucket name — mainly useful for confirming what got created, and as a
// sanity-check value to compare against the hardcoded name in envs/prod's
// backend.tf (they should always match).
output "bucket_name" {
  value = aws_s3_bucket.tf_state.bucket
}

// The full ARN — not strictly needed by anything downstream right now, but
// worth having on hand if an IAM policy elsewhere ever needs to reference
// this bucket specifically (e.g. tightening the TerraformStateAndLockAccess
// statement in the CloudEngineerReadOnly permission set to this exact ARN
// instead of a name string).
output "bucket_arn" {
  value = aws_s3_bucket.tf_state.arn
}
