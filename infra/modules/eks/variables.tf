variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  description = "Compute-tier subnet ids from the network module — control plane ENIs and the baseline node group both live here."
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnet ids from the network module — tagged kubernetes.io/role/elb for the ingress controller's internet-facing LB. Not used for control plane or node placement."
  type        = list(string)
}

variable "cluster_version" {
  description = "EKS/Kubernetes version. Defaults to a specific version rather than 'latest' so upgrades are a deliberate tfvars change, not a surprise on the next apply."
  type        = string
  default     = "1.31"
}

variable "cluster_endpoint_public_access" {
  description = "true = kubectl works from a laptop without a bastion/VPN. Training-account tradeoff (no VPN infra exists here) — name it in DECISIONS.md if it comes up."
  type        = bool
  default     = true
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "Left wide open by default since there's no static team IP to scope this to. Tighten if/when that changes."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

## The four node-group vars below are genuinely different between prod and staging tfvars —
## same parameterization pattern as data/variables.tf's min_capacity/max_capacity. No default
## on node_instance_types/desired/min/max on purpose.

variable "node_instance_types" {
  type = list(string)
}

variable "node_capacity_type" {
  description = "ON_DEMAND or SPOT. Prod: ON_DEMAND (predictable burst-test behavior). Staging: SPOT is a reasonable place to prove the parameterization, since staging is throwaway anyway."
  type        = string
  default     = "ON_DEMAND"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.node_capacity_type)
    error_message = "node_capacity_type must be ON_DEMAND or SPOT."
  }
}

variable "node_desired_size" {
  type = number
}

variable "node_min_size" {
  type = number
}

variable "node_max_size" {
  type = number
}

variable "tags" {
  type    = map(string)
  default = {}
}
