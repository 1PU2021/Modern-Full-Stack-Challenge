output "cluster_id" {
  value = aws_rds_cluster.this.id
}

output "cluster_arn" {
  value = aws_rds_cluster.this.arn
}

// Always use this endpoint for writes.
output "writer_endpoint" {
  value = aws_rds_cluster.this.endpoint
}

// Default endpoint for reads — the app falls back to writer_endpoint when
// AuroraReplicaLag climbs past ~200ms.
output "reader_endpoint" {
  value = aws_rds_cluster.this.reader_endpoint
}

output "security_group_id" {
  value = aws_security_group.aurora.id
}

// The Secrets Manager secret ARN AWS created automatically for the master
// credential (manage_master_user_password = true). External Secrets Operator's
// IAM role needs read access to this ARN specifically.
output "master_user_secret_arn" {
  value = aws_rds_cluster.this.master_user_secret[0].secret_arn
}
