// Which environment this instance of the module is building — prod or staging.
// Purely a naming/tagging label; it doesn't change any routing or security behavior.
variable "environment" {
  type = string
}

// The IP address range for the whole VPC. Give prod and staging different ranges
// (e.g. 10.0.0.0/16 vs 10.1.0.0/16) so the two would never collide if they were ever
// connected together (VPC peering, Transit Gateway, etc.) later.
variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

// How many availability zones to spread subnets across. The challenge brief requires
// at least 3. us-east-2 actually has more AZs available if we ever want to go to 4.
variable "az_count" {
  type    = number
  default = 3

  // A /16 VPC gets carved into 16 equally-sized /20 blocks (see main.tf). We use 3
  // blocks per AZ (public/private/data), so 4 AZs would need 12 of the 16 blocks —
  // the max this scheme supports. This just stops someone setting az_count = 6 and
  // getting a confusing "ran out of address space" error deep in main.tf instead.
  validation {
    condition     = var.az_count >= 3 && var.az_count <= 4
    error_message = "az_count must be 3 or 4 — a /16 VPC split into /20s only has room for 4 AZs across 3 subnet tiers."
  }
}

// Controls how many NAT gateways get built for the private subnets' internet egress.
//   true  = ONE NAT gateway shared by every private subnet. Cheap, but if that NAT's
//           AZ goes down, every private subnet loses outbound internet until it's
//           rebuilt — even though the subnets themselves are spread across all AZs.
//           This is the deliberate baseline tradeoff — call it out by name in DECISIONS.md.
//   false = one NAT gateway PER AZ. Real high availability, roughly 3x the NAT cost.
// Kept as a variable (not hardcoded true) specifically so the staging tfvars can prove
// this module parameterizes it, even though only the baseline (true) actually gets applied.
variable "single_nat_gateway" {
  type    = bool
  default = true
}

// Tags merged onto every single resource this module creates — see the tagging
// convention doc for which keys are required (Project, Owner, CostCenter, etc.).
variable "tags" {
  type    = map(string)
  default = {}
}
