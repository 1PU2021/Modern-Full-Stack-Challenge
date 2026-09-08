// Consumed directly by the data module (vpc_id input) and will be needed by
// Caleb's eks module once it exists.
output "vpc_id" {
  value = aws_vpc.this.id
}

// Mainly a sanity-check value — confirms the actual CIDR block that got created
// matches what var.vpc_cidr was set to.
output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

// Which AZs actually got used (first az_count of whatever the region returned).
// Useful for cross-checking that the Aurora subnet group in the data module
// really did land the writer/reader in different AZs.
output "availability_zones" {
  value = local.azs
}

// Where the ingress load balancer eventually lives — Caleb's orchestration
// module will need these once ingress/TLS gets built.
output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

// Where EKS nodes/pods live — Caleb's eks module needs these to place the
// cluster's worker nodes.
output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

// Consumed directly by the data module (data_subnet_ids input) — this is what
// the Aurora subnet group actually gets built from.
output "data_subnet_ids" {
  value = aws_subnet.data[*].id
}

output "private_subnet_cidrs" {
  description = "Only needed for the data module's NACL cross-checks / docs — the actual DB access rule should be SG-to-SG, not CIDR-based."
  value       = local.private_cidrs
}

output "data_network_acl_id" {
  description = "Needed later by whoever runs the AZ-loss chaos drill (brief §8) to insert a temporary deny rule."
  value       = aws_network_acl.data.id
}

// Confirms how many NAT gateways actually got built — 1 if single_nat_gateway
// is true, one per AZ if false. Useful for a quick cost sanity-check.
output "nat_gateway_ids" {
  value = aws_nat_gateway.this[*].id
}
