locals {
  common_tags = merge(var.tags, {
    Project = "modern-full-stack-challenge"
  })
}

module "network" {
  source = "../../modules/network"

  environment        = var.environment
  vpc_cidr           = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  tags               = local.common_tags
}

## infra/modules/eks now exists (Jay, 8/30/26 — architecture-decisions.md §4:
## the EKS module is Infrastructure, confirmed by Felipe, not Caleb's
## Orchestration territory). node_security_group_id below is what module.data
## needs for its SG-to-SG ingress rule.
module "eks" {
  source = "../../modules/eks"

  environment        = var.environment
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  public_subnet_ids  = module.network.public_subnet_ids

  node_instance_types = var.eks_node_instance_types
  node_capacity_type  = var.eks_node_capacity_type
  node_desired_size   = var.eks_node_desired_size
  node_min_size       = var.eks_node_min_size
  node_max_size       = var.eks_node_max_size

  tags = local.common_tags
}

module "data" {
  source = "../../modules/data"

  environment                = var.environment
  vpc_id                     = module.network.vpc_id
  data_subnet_ids            = module.network.data_subnet_ids
  eks_node_security_group_id = module.eks.node_security_group_id
  min_capacity               = var.min_capacity
  max_capacity               = var.max_capacity
  backup_retention_days      = var.backup_retention_days
  deletion_protection        = var.deletion_protection
  tags                       = local.common_tags
}

module "queues" {
  source = "../../modules/queues"

  environment = var.environment
  tags        = local.common_tags
}
