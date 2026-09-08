environment = "staging"
// Staging's own /16 range, distinct from prod's 10.0.0.0/16 — see network/variables.tf
// and this folder's variables.tf comment on vpc_cidr.
vpc_cidr = "10.1.0.0/16"
az_count = 3 // meets the brief's minimum of 3 AZs, same as prod
// Set to false here (vs. true in prod) specifically to prove the module actually
// parameterizes this switch, per network/variables.tf's own comment: "Kept as a
// variable specifically so staging can prove the modules parameterize this even
// though only the baseline (true) actually gets applied for prod." Since staging
// is plan-only evidence (per architecture-decisions.md §8 — prod is the only one
// actually applied), this never costs anything for real.
single_nat_gateway = false
// Deliberately smaller than prod's 0.5/4 — proves the module parameterizes
// sizing per architecture-decisions.md §8, not meant to reflect any real
// staging traffic profile.
min_capacity = 0.5
max_capacity = 1
// Shorter than prod's 7 days — staging is throwaway, no real recovery need.
backup_retention_days = 1
// Explicit false (overrides the module/variable default of true) — per
// data/variables.tf: "Leave false for staging so a throwaway plan/destroy
// cycle doesn't require a manual override."
deletion_protection = false
tags = {
  Owner = "Jay"
}
// SPOT here (vs. ON_DEMAND default used by prod) is the parameterization proof
// for this variable — staging is throwaway, so interruption risk doesn't matter.
eks_node_instance_types = ["t3.small"]
eks_node_capacity_type  = "SPOT"
eks_node_desired_size   = 1
eks_node_min_size       = 1
eks_node_max_size       = 2
