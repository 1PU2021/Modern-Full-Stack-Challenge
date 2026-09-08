# eks

The EKS cluster and its compute. Autoscaling design behind it: Karpenter will provision nodes
on demand (not wired up in this module yet — see "What this module deliberately does NOT build
yet" below); KEDA scales dispatch pods on SQS queue depth rather than CPU, but that's a
Helm/Orchestration piece, not part of this module.

## What this module builds

- EKS control plane (private + public API endpoint, control-plane logging to CloudWatch)
- Cluster IAM role + node IAM role (worker policy, CNI policy, ECR read-only, SSM — no SSH keypair)
- OIDC provider (IRSA prerequisite, not currently consumed by anything but cheap to have)
- Node security group — **this is the id that `module.data`'s `eks_node_security_group_id`
  input expects.** SG-to-SG only, never a CIDR range (`architecture-decisions.md` §3).
- A baseline managed node group (fixed size, not Karpenter) so something is schedulable
  immediately after `apply` — sized independently by `node_desired_size`/`min`/`max` per env.
- Core addons: `vpc-cni`, `coredns`, `kube-proxy`, `eks-pod-identity-agent`.
- Subnet tags (`kubernetes.io/role/elb`, `.../internal-elb`, `.../cluster/<name>`) so the
  ingress controller's Helm chart can auto-discover subnets for its load balancer.

## What this module deliberately does NOT build yet

- **Karpenter** (controller IAM role, node IAM role for Karpenter-provisioned nodes,
  interruption-handling SQS queue/EventBridge rules). The baseline node group above is the
  Phase-2-first-apply stand-in — Karpenter is still the compute-autoscaler decision
  (`architecture-decisions.md` §1), this is sequencing per the phased build plan (§10), not a
  design reversal.
- **Per-workload EKS Pod Identity associations** (e.g. External Secrets Operator's role to
  read the Aurora master secret from `module.data.master_user_secret_arn`). The
  `eks-pod-identity-agent` addon is the one-time cluster prerequisite; the actual association
  resource gets added once a real service account exists to attach it to.

## Wiring into an env root

```hcl
module "eks" {
  source = "../../modules/eks"

  environment         = var.environment
  vpc_id              = module.network.vpc_id
  private_subnet_ids  = module.network.private_subnet_ids
  public_subnet_ids   = module.network.public_subnet_ids

  node_instance_types = var.eks_node_instance_types
  node_capacity_type  = var.eks_node_capacity_type
  node_desired_size   = var.eks_node_desired_size
  node_min_size       = var.eks_node_min_size
  node_max_size       = var.eks_node_max_size

  tags = local.common_tags
}

module "data" {
  source = "../../modules/data"
  # ...
  eks_node_security_group_id = module.eks.node_security_group_id
  # ...
}
```

Once this is wired in, delete the standalone `eks_node_security_group_id` variable from the
env root's `variables.tf` — it stops being an unset, fail-loudly input and becomes a real
cross-module reference instead.

## New provider requirement

This module's OIDC provider setup uses a `tls_certificate` data source (`hashicorp/tls`). Add
it to the env root's `versions.tf`:

```hcl
tls = {
  source  = "hashicorp/tls"
  version = "~> 4.0"
}
```
