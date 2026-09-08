// The "hospital building" layout (architecture-decisions.md §3):
//   public subnets  = lobby        -> ingress load balancer, internet-facing
//   private subnets = staff floor  -> EKS pods, no public IPs, outbound via NAT only
//   data subnets    = records vault -> Aurora, no NAT/IGW route in EITHER direction,
//                                       reachable only from the private tier
//
// Everything is spread across az_count AZs (>= 3) so the DB subnet group can survive,
// and the later AZ-loss chaos drill can actually blackhole, a single AZ.

// Look up the actual AZ names available in this region so we're not hardcoding
// "us-east-2a" etc. — makes the module portable to another region without edits.
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  // Only take the first az_count AZs from whatever the region has.
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  // A /16 VPC splits into 16 blocks of /20 each. Each tier gets a contiguous range of
  // those blocks, one /20 per AZ:
  //   indices 0-3  -> public
  //   indices 4-7  -> private (compute)
  //   indices 8-11 -> data (isolated)
  // cidrsubnet(base, 4, i) means "carve 4 extra bits off base, take block number i."
  public_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 4)]
  data_cidrs    = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  // Tags applied to every resource below, merged with whatever the caller passed in.
  common_tags = merge(var.tags, {
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "network"
  })
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true // required for EKS and for private Aurora endpoints to resolve correctly

  tags = merge(local.common_tags, {
    Name = "${var.environment}-vpc"
  })
}

// The internet gateway — the VPC's only real "door to the street." Only the public
// route table (below) actually points traffic at it.
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${var.environment}-igw"
  })
}

// ============================================================================
// PUBLIC TIER — the lobby
// ============================================================================

// One public subnet per AZ. map_public_ip_on_launch means anything launched directly
// into these subnets gets a public IP automatically — fine here since nothing sensitive
// runs in this tier (just the ingress load balancer eventually).
resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${var.environment}-public-${local.azs[count.index]}"
    Tier = "public"
  })

  // The eks module's aws_ec2_tag resources separately own these two keys (ingress LB
  // subnet auto-discovery, architecture-decisions.md §13) — without this, this resource's
  // own tags block (which doesn't know about those keys) fights with them on every
  // plan/apply, alternately adding and stripping the tags. Ignore them here so the eks
  // module stays the sole owner.
  lifecycle {
    ignore_changes = [
      tags["kubernetes.io/role/elb"],
      tags["kubernetes.io/cluster/prod-alerts-eks"],
    ]
  }
}

// One shared route table for all public subnets: anything not headed within the VPC
// (0.0.0.0/0) goes out the internet gateway.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.common_tags, {
    Name = "${var.environment}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

// ============================================================================
// NAT — how the private tier reaches the internet (outbound only)
// ============================================================================

// single_nat_gateway = true (the default): build just 1 elastic IP / NAT gateway,
// in AZ index 0. false: build one per AZ instead. The count expression picks which.
resource "aws_eip" "nat" {
  count  = var.single_nat_gateway ? 1 : var.az_count
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${var.environment}-nat-eip-${count.index}"
  })
}

resource "aws_nat_gateway" "this" {
  count = var.single_nat_gateway ? 1 : var.az_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id // NAT gateways live in a PUBLIC subnet, even though they serve the PRIVATE tier

  tags = merge(local.common_tags, {
    Name = "${var.environment}-nat-${count.index}"
  })

  depends_on = [aws_internet_gateway.this] // NAT needs the IGW to exist first or it can fail to provision
}

// ============================================================================
// PRIVATE TIER — the staff floor (EKS pods)
// ============================================================================

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]
  // no map_public_ip_on_launch here — this tier never gets public IPs

  tags = merge(local.common_tags, {
    Name = "${var.environment}-private-${local.azs[count.index]}"
    Tier = "private"
  })

  // Same reasoning as the public subnet above — these two keys are owned by the eks
  // module's aws_ec2_tag resources, not this resource's own tags block.
  lifecycle {
    ignore_changes = [
      tags["kubernetes.io/role/internal-elb"],
      tags["kubernetes.io/cluster/prod-alerts-eks"],
    ]
  }
}

// Each AZ gets its OWN private route table (unlike the public tier, which shares one) —
// this is what lets single_nat_gateway=false route each AZ's egress through its own NAT
// instead of all of them sharing one.
resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    // If we only built 1 NAT (single_nat_gateway=true), every AZ's table points at that
    // same NAT (index 0). Otherwise each AZ points at its own.
    nat_gateway_id = var.single_nat_gateway ? aws_nat_gateway.this[0].id : aws_nat_gateway.this[count.index].id
  }

  tags = merge(local.common_tags, {
    Name = "${var.environment}-private-rt-${local.azs[count.index]}"
  })
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

// ============================================================================
// DATA TIER — the records vault (isolated, Aurora lives here)
// ============================================================================

resource "aws_subnet" "data" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.data_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = merge(local.common_tags, {
    Name = "${var.environment}-data-${local.azs[count.index]}"
    Tier = "data"
  })
}

// Deliberately empty of routes — no NAT, no IGW, nothing pointing outside the VPC.
// AWS adds an implicit "local" route automatically so traffic within the VPC still
// works; we don't have to (and can't) declare that ourselves.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${var.environment}-data-rt"
  })
}

resource "aws_route_table_association" "data" {
  count          = var.az_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

// ============================================================================
// SECOND SECURITY LAYER — NACL on the data tier
// ============================================================================
// Security groups (defined in the data module, SG-to-SG only) do the primary
// enforcement. This NACL is the coarser, subnet-level second layer: only the private
// tier's own CIDR ranges may even reach the data subnets, and only on Postgres's port.
//
// Custom NACLs deny everything by default unless a rule explicitly allows it — so we
// only need to write ALLOW rules below, no explicit DENY rule required.
//
// Rule numbers 100-199 are used here. Numbers 200+ are left free on purpose for the
// AZ-loss chaos drill (brief §8) to insert a temporary DENY rule blackholing one AZ's
// data subnet, without needing to renumber anything in this file.

resource "aws_network_acl" "data" {
  vpc_id     = aws_vpc.this.id
  subnet_ids = aws_subnet.data[*].id

  tags = merge(local.common_tags, {
    Name = "${var.environment}-data-nacl"
  })
}

// INBOUND: allow Postgres (5432) from each AZ's private-tier CIDR, one rule per AZ.
resource "aws_network_acl_rule" "data_ingress_from_private" {
  count          = var.az_count
  network_acl_id = aws_network_acl.data.id
  rule_number    = 100 + count.index
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = local.private_cidrs[count.index]
  from_port      = 5432
  to_port        = 5432
}

// OUTBOUND: NACLs are stateless, so return traffic needs its own explicit rule — this
// allows the response packets (on the client's ephemeral port range) back to the
// private tier. Without this, connections would get accepted but replies would be dropped.
resource "aws_network_acl_rule" "data_egress_ephemeral_to_private" {
  count          = var.az_count
  network_acl_id = aws_network_acl.data.id
  rule_number    = 100 + count.index
  egress         = true
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = local.private_cidrs[count.index]
  from_port      = 1024
  to_port        = 65535
}
