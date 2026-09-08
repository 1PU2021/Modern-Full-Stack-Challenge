variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

// Isolated data-tier subnet ids, coming from the network module's output. Needs to
// span at least 2 AZs so the writer and reader instances can land in different ones.
variable "data_subnet_ids" {
  type = list(string)
}

// The EKS node/pod security group id — from Caleb's orchestration module, not this one.
// This is the ONLY thing allowed to talk to Postgres (SG-to-SG, never a CIDR range,
// per architecture-decisions.md §3). This module can only consume this id, not create
// it, since the orchestration module owns the EKS side.
variable "eks_node_security_group_id" {
  type = string
}

variable "database_name" {
  type    = string
  default = "notifications"
}

variable "master_username" {
  type    = string
  default = "postgres"
}

// Must be 16.x — PostGIS (polygon geotargeting) and Ben's spec both require Postgres 16.
variable "engine_version" {
  type    = string
  default = "16.14"
}

// Serverless v2 ACU floor/ceiling. These two numbers are exactly what should differ
// between prod.tfvars and staging.tfvars to prove the module actually parameterizes
// sizing, not just environment name.
variable "min_capacity" {
  type = number

  validation {
    condition     = var.min_capacity >= 0.5
    error_message = "min_capacity must be at least 0.5 ACU — Aurora Serverless v2's actual floor."
  }
}
variable "max_capacity" {
  type = number

  validation {
    condition     = var.max_capacity >= var.min_capacity
    error_message = "max_capacity must be >= min_capacity."
  }
}

variable "backup_retention_days" {
  type = number
}

// true for prod (protects against accidental terraform destroy). Leave false for
// staging so a throwaway plan/destroy cycle doesn't need a manual override step.
variable "deletion_protection" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
