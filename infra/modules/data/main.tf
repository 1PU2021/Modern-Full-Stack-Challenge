// Aurora PostgreSQL Serverless v2 — one writer, one reader in a different AZ
// (architecture-decisions.md §3). Lives in the network module's isolated data
// subnets: no NAT/IGW route in or out, reachable only from the EKS SG.
//
// NOTE: PostGIS itself is turned on with `CREATE EXTENSION postgis;` inside Ben's
// first migration — that's app/schema territory, not Terraform. This module's only
// job is picking an engine version (16.x) that supports it and giving it a network
// path to exist on.

locals {
  common_tags = merge(var.tags, {
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "data"
  })
}

// Tells RDS which subnets it's allowed to place cluster instances into.
resource "aws_db_subnet_group" "this" {
  name       = "${var.environment}-aurora-subnet-group"
  subnet_ids = var.data_subnet_ids

  tags = merge(local.common_tags, {
    Name = "${var.environment}-aurora-subnet-group"
  })
}

// A customer-managed key instead of the AWS-managed default — gives us a real key
// policy to point at for the encryption-at-rest requirement, and something we
// control the rotation of.
resource "aws_kms_key" "aurora" {
  description             = "${var.environment} Aurora storage encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(local.common_tags, {
    Name = "${var.environment}-aurora-kms"
  })
}

resource "aws_kms_alias" "aurora" {
  name          = "alias/${var.environment}-aurora"
  target_key_id = aws_kms_key.aurora.key_id
}

// The security group Aurora sits behind. No CIDR rules — ever. A CIDR rule here
// would read to an auditor as "the whole network can reach this," where an
// SG-to-SG rule reads as "specifically the pods, and nothing else, can."
resource "aws_security_group" "aurora" {
  name        = "${var.environment}-aurora-sg"
  description = "Aurora - inbound 5432 from the EKS node/pod SG only, no outbound rules"
  vpc_id      = var.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.environment}-aurora-sg"
  })
}

// The one and only inbound rule: Postgres, from the EKS SG, nothing else.
resource "aws_vpc_security_group_ingress_rule" "from_eks" {
  security_group_id            = aws_security_group.aurora.id
  referenced_security_group_id = var.eks_node_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from EKS node/pod SG only"
}
// No egress rule resource here on purpose — the DB never initiates outbound
// connections (traffic is one-directional: pods -> DB, never DB -> pods). AWS still
// applies its own implicit "allow all outbound" default to new SGs; flagging that
// here so it isn't mistaken for a rule we deliberately wrote.

// Forces every connection to use TLS — this is the encryption-in-transit requirement.
resource "aws_rds_cluster_parameter_group" "this" {
  name        = "${var.environment}-aurora-pg16"
  family      = "aurora-postgresql16"
  description = "Forces TLS for all connections"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = local.common_tags
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = "${var.environment}-alerts-aurora"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" // "provisioned" + serverlessv2_scaling_configuration block below = Serverless v2 (not the older, different "serverless" v1 engine_mode)
  engine_version     = var.engine_version
  database_name      = var.database_name
  master_username    = var.master_username

  // Aurora-native integration: AWS creates AND rotates the master password itself,
  // storing it directly in Secrets Manager. Terraform never sees or stores the
  // actual password — and this is the same secret External Secrets Operator later
  // reads into pods via EKS Pod Identity.
  manage_master_user_password = true

  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name

  storage_encrypted = true
  kms_key_id        = aws_kms_key.aurora.arn

  backup_retention_period = var.backup_retention_days
  preferred_backup_window = "07:00-09:00" // UTC — roughly 1-3am Central, the team's low-traffic window

  deletion_protection = var.deletion_protection
  skip_final_snapshot = !var.deletion_protection // staging: skip so `destroy` doesn't hang waiting for a snapshot; prod: always take one

  enabled_cloudwatch_logs_exports = ["postgresql"]

  // This block is what actually makes it "Serverless v2" — the cluster scales its
  // ACUs between these two numbers automatically based on load.
  serverlessv2_scaling_configuration {
    min_capacity = var.min_capacity
    max_capacity = var.max_capacity
  }

  tags = local.common_tags
}

// The writer instance. RDS automatically spreads cluster instances across the
// subnet group's AZs — we don't pin availability_zone by hand, we just make sure
// the subnet group spans 2+ AZs so writer and reader end up in different ones.
resource "aws_rds_cluster_instance" "writer" {
  identifier           = "${var.environment}-alerts-aurora-writer"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = "db.serverless" // required instance class for Serverless v2
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  db_subnet_group_name = aws_db_subnet_group.this.name
  publicly_accessible  = false

  tags = merge(local.common_tags, { Role = "writer" })
}

// The reader instance — this is what makes AuroraReplicaLag a real, meaningful
// metric, and gives the app's read-router something to actually fail over from
// when lag gets too high (architecture-decisions.md §3).
resource "aws_rds_cluster_instance" "reader" {
  identifier           = "${var.environment}-alerts-aurora-reader"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  db_subnet_group_name = aws_db_subnet_group.this.name
  publicly_accessible  = false

  tags = merge(local.common_tags, { Role = "reader" })

  depends_on = [aws_rds_cluster_instance.writer] // avoid both instances racing to be elected writer
}
