environment = "prod"
// Prod's own /16 range. envs/staging/terraform.tfvars gets a different one
// (10.1.0.0/16) so the two would never collide if ever peered together —
// see network/variables.tf.
vpc_cidr           = "10.0.0.0/16"
az_count           = 3    // meets the brief's minimum of 3 AZs
single_nat_gateway = true // deliberate cost tradeoff — see network/variables.tf for the full reasoning
// Aurora Serverless v2 ACU floor/ceiling — the two numbers architecture-decisions.md
// §8 and data/variables.tf flag as needing to genuinely differ between prod and
// staging. 0.5 is the actual AWS minimum for Serverless v2. 4 ACU is a reasonable
// ceiling for this training/demo workload, not a real production traffic profile —
// worth revisiting once the burst/load test (Aundrea's Phase 4 work) shows real numbers.
min_capacity          = 0.5
max_capacity          = 4
backup_retention_days = 7    // standard prod retention
deletion_protection   = true // matches data module's own default; explicit here for clarity
// Environment and Module (component) attribution for cost tracking is already
// handled automatically inside every module's own common_tags merge — this is
// just an extra identifying tag on top, not required by the brief's §10.
tags = {
  Owner = "Jay"
}
eks_node_instance_types = ["t3.medium"]
eks_node_desired_size   = 3
eks_node_min_size       = 2
eks_node_max_size       = 4
