variable "environment" {
  type    = string
  default = "prod"
}

## No default on purpose — network's own variables.tf comment says prod and
## staging should get genuinely different ranges (e.g. 10.0.0.0/16 vs
## 10.1.0.0/16) so they'd never collide if ever peered. Forcing this to be set
## explicitly per-environment in tfvars prevents both accidentally defaulting
## to the same CIDR.
variable "vpc_cidr" {
  type = string
}

variable "az_count" {
  type    = number
  default = 3
}

variable "single_nat_gateway" {
  type    = bool
  default = true
}

## infra/modules/eks now exists (Jay, 8/30/26 — see architecture-decisions.md §4).
## These four are genuinely different between prod and staging tfvars, same
## parameterization pattern as min_capacity/max_capacity below. No default on
## purpose (except capacity_type) so terraform plan fails loudly if a real
## value isn't set.
variable "eks_node_instance_types" {
  type = list(string)
}
variable "eks_node_capacity_type" {
  type    = string
  default = "ON_DEMAND"
}
variable "eks_node_desired_size" {
  type = number
}
variable "eks_node_min_size" {
  type = number
}
variable "eks_node_max_size" {
  type = number
}

## The two numbers that should genuinely differ between envs/prod and
## envs/staging tfvars, per architecture-decisions.md §8 and data/variables.tf's
## own comment on these two variables.
variable "min_capacity" {
  type = number
}

variable "max_capacity" {
  type = number
}

variable "backup_retention_days" {
  type = number
}

## data module's own default is true (prod-safe). Exposed here so staging's
## tfvars can explicitly set false — per data/variables.tf: "Leave false for
## staging so a throwaway plan/destroy cycle doesn't require a manual override."
variable "deletion_protection" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
