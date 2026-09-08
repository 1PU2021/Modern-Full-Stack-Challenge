output "vpc_id" {
  value = module.network.vpc_id
}
// Aurora writer/reader hostnames — these are what Caleb's Helm chart needs to
// build the app's DATABASE_URL/APP_DATABASE_URL connection strings via External
// Secrets Operator. Nothing constructs the full connection string here; this
// module's job stops at exposing the raw pieces (hostname + secret ARN below).
output "database_writer_endpoint" {
  value = module.data.writer_endpoint
}
output "database_reader_endpoint" {
  value = module.data.reader_endpoint
}
output "database_master_user_secret_arn" {
  description = "Grant External Secrets Operator's IAM role read access to this ARN — see data/outputs.tf."
  value       = module.data.master_user_secret_arn
}
// These map directly onto the app's own env var names, confirmed against
// docker-compose.yml (Ben's app):
//   ALERT_FANOUT_QUEUE_URL       = alert_fanout_queue_url
//   RECIPIENT_DISPATCH_QUEUE_URL = recipient_dispatch_queue_url
output "alert_fanout_queue_url" {
  value = module.queues.alert_fanout_queue_url
}
output "recipient_dispatch_queue_url" {
  value = module.queues.recipient_dispatch_queue_url
}
// Feeds `aws eks update-kubeconfig --name <eks_cluster_name> --region us-east-2`
// once the cluster is actually applied — cluster_name is the only one that
// command strictly needs, but endpoint/CA data are exposed too since Caleb's
// Helm/kubectl tooling or a CI step may want them without a separate API call.
output "eks_cluster_name" {
  value = module.eks.cluster_name
}
output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}
output "eks_cluster_certificate_authority_data" {
  description = "Base64-encoded cluster CA cert — see modules/eks/outputs.tf."
  value       = module.eks.cluster_certificate_authority_data
}
