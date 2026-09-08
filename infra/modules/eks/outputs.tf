output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority_data" {
  description = "Feeds a kubeconfig (or the Kubernetes/Helm Terraform provider blocks) without a separate `aws eks update-kubeconfig` call in CI."
  value       = aws_eks_cluster.this.certificate_authority[0].data
}

output "cluster_arn" {
  value = aws_eks_cluster.this.arn
}

output "cluster_security_group_id" {
  description = "EKS-managed control-plane <-> node security group (distinct from node_security_group_id below, which is this module's own node/pod SG)."
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "node_security_group_id" {
  description = "THE id to wire into module.data's eks_node_security_group_id input — architecture-decisions.md §3, SG-to-SG only."
  value       = aws_security_group.node.id
}

output "node_role_arn" {
  value = aws_iam_role.node.arn
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.cluster.arn
}

output "oidc_provider_url" {
  value = aws_iam_openid_connect_provider.cluster.url
}
