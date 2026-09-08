// EKS module — the cluster itself is Infrastructure (architecture-decisions.md §4, confirmed
// directly by Felipe 8/30/26: "EKS module is infra, would fall on the Cloud engineer"). This
// module owns: the control plane, a baseline managed node group (enough capacity to actually
// schedule pods and demo a deploy), the node/cluster IAM roles, core addons, and the node
// security group that the data module's Aurora SG references (SG-to-SG only, never a CIDR
// range — architecture-decisions.md §3).
//
// NOT in this module yet, deliberately (phased build plan, architecture-decisions.md §10):
// Karpenter's own controller/IAM/interruption-queue resources, and per-workload EKS Pod
// Identity associations (e.g. External Secrets Operator's role to read the Aurora master
// secret). The baseline managed node group below is what lets a real `terraform apply`
// produce something schedulable now, without waiting on Karpenter to be wired up. Karpenter
// is still the compute-autoscaler decision (§1) — this is sequencing, not a design change.

locals {
  cluster_name = "${var.environment}-alerts-eks"

  common_tags = merge(var.tags, {
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "eks"
  })
}

// --- Cluster IAM role -------------------------------------------------------

resource "aws_iam_role" "cluster" {
  name                 = "${local.cluster_name}-cluster-role"
  permissions_boundary = "arn:aws:iam::942010118414:policy/terraform-created-role-boundary"
  path                 = "/workload/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

// --- Control plane ------------------------------------------------------------
// Placed across the private (compute) subnets from the network module — control plane ENIs
// live in the same tier as the pods they talk to. Public endpoint access defaults on so the
// team can run kubectl from a laptop without a bastion/VPN (training-account tradeoff — name
// it in DECISIONS.md, tighten cluster_endpoint_public_access_cidrs if that becomes worth doing).

resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${local.cluster_name}/cluster"
  retention_in_days = 7

  tags = local.common_tags
}

resource "aws_eks_cluster" "this" {
  name     = local.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.cluster_version

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = var.cluster_endpoint_public_access
    public_access_cidrs     = var.cluster_endpoint_public_access_cidrs
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  tags = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.cluster_policy,
    aws_cloudwatch_log_group.cluster,
  ]
}

// --- OIDC provider (IRSA) ---------------------------------------------------
// EKS Pod Identity (the addon below) is the primary mechanism this build uses for pod IAM
// (architecture-decisions.md §3 — ESO's role to read the Aurora secret, "not the node role,
// not a hardcoded Helm value"). This OIDC provider is a cheap no-regrets prerequisite anyway:
// some third-party charts (e.g. AWS Load Balancer Controller, if that's how ingress ends up
// getting its LB) only support IRSA, not Pod Identity yet.

data "tls_certificate" "cluster" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.cluster.certificates[0].sha1_fingerprint]

  tags = local.common_tags
}

// --- Node IAM role ------------------------------------------------------------

resource "aws_iam_role" "node" {
  name                 = "${local.cluster_name}-node-role"
  permissions_boundary = "arn:aws:iam::942010118414:policy/terraform-created-role-boundary"
  path                 = "/workload/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

// SSM instead of a bastion/SSH keypair — "shell into a node" becomes `aws ssm start-session`,
// consistent with the account's no-standing-SSH-key posture (no keypair to leak or rotate).
resource "aws_iam_role_policy_attachment" "node_ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

// --- Node security group ----------------------------------------------------
// THE security group referenced everywhere else as "the EKS node/pod SG". envs/*/main.tf
// wires this module's node_security_group_id output into module.data's
// eks_node_security_group_id input — architecture-decisions.md §3: SG-to-SG only, never a
// CIDR range.

resource "aws_security_group" "node" {
  name        = "${local.cluster_name}-node-sg"
  description = "EKS worker nodes / pods. The Aurora SG allows inbound 5432 from this SG specifically - see infra/modules/data."
  vpc_id      = var.vpc_id

  tags = merge(local.common_tags, {
    Name = "${local.cluster_name}-node-sg"
  })
}

// Node-to-node / pod-to-pod (app -> app calls, kube-dns, etc). Standard EKS node SG shape.
resource "aws_vpc_security_group_ingress_rule" "node_self" {
  security_group_id            = aws_security_group.node.id
  referenced_security_group_id = aws_security_group.node.id
  ip_protocol                  = "-1"
  description                  = "Node-to-node and pod-to-pod"
}

// Control plane -> node (kubelet, admission webhooks). EKS also auto-manages its own
// control-plane<->node security group (exposed below as cluster_security_group_id) — this
// rule is the explicit version scoped to this module's own node SG.
resource "aws_vpc_security_group_ingress_rule" "node_from_cluster" {
  security_group_id            = aws_security_group.node.id
  referenced_security_group_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  from_port                    = 1025
  to_port                      = 65535
  ip_protocol                  = "tcp"
  description                  = "Control plane to kubelet"
}

resource "aws_vpc_security_group_egress_rule" "node_all" {
  security_group_id = aws_security_group.node.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Nodes reach ECR/S3/Secrets Manager/Aurora/provider stubs via NAT"
}

// --- Managed node group launch template --------------------------------------
// Attach both:
//   1. the EKS-managed cluster security group, required for normal EKS
//      control-plane/node communication
//   2. this module's dedicated node/pod security group, which Aurora trusts
//      for PostgreSQL traffic on 5432.
//
// Without this launch template, the custom aws_security_group.node resource
// exists but is never actually attached to the EC2 instances in the managed
// node group.
resource "aws_launch_template" "baseline" {
  name_prefix = "${local.cluster_name}-baseline-"

  vpc_security_group_ids = [
    aws_eks_cluster.this.vpc_config[0].cluster_security_group_id,
    aws_security_group.node.id,
  ]

  tag_specifications {
    resource_type = "instance"

    tags = merge(local.common_tags, {
      Name = "${local.cluster_name}-baseline"
    })
  }

  tag_specifications {
    resource_type = "network-interface"

    tags = local.common_tags
  }

  lifecycle {
    create_before_destroy = true
  }
}

// --- Node authentication mapping ---------------------------------------------
// The cluster's aws-auth ConfigMap is what actually lets EC2 instances in the managed node
// group authenticate as kubelet against the API server — without an entry here, kubelet gets
// no RBAC identity at all and nodes never join. This is exactly what happened on the first
// real apply: the authenticator CloudWatch log showed only terraform-execution-role mapped to
// system:masters, nothing for the node role. This cluster runs in ConfigMap-based auth mode
// (not the newer access-entries API), so EKS's automatic node-group registration never
// applies here — it has to be managed explicitly.
//
// kubernetes_config_map_v1_data (not a plain kubernetes_config_map) is deliberate: the
// aws-auth ConfigMap already exists by the time this runs — EKS creates it automatically at
// cluster creation and seeds it with the cluster-creator's own admin mapping (that's the
// terraform-execution-role entry already visible in the log). A regular kubernetes_config_map
// resource would try to CREATE the object and fail since it's already there; this resource
// type patches fields on a ConfigMap someone else already owns, without taking over its
// full lifecycle.

resource "kubernetes_config_map_v1_data" "aws_auth" {
  metadata {
    name      = "aws-auth"
    namespace = "kube-system"
  }

  data = {
    mapRoles = yamlencode([
      {
        rolearn  = aws_iam_role.node.arn
        username = "system:node:{{EC2PrivateDNSName}}"
        groups   = ["system:bootstrappers", "system:nodes"]
      },
      {
        rolearn  = "arn:aws:iam::942010118414:role/AWSReservedSSO_SREObservability_de4926b3e340c697"
        username = "aundrea"
        groups   = ["system:masters"]
      }
    ])
    mapUsers = yamlencode([
      {
        userarn  = "arn:aws:iam::942010118414:user/CalebSysAdmin"
        username = "caleb"
        groups   = ["system:masters"]
      }
    ])
  }

  force = true

  depends_on = [aws_eks_cluster.this]
}
// --- Baseline managed node group ---------------------------------------------
// Not Karpenter yet (see module header) — fixed-size baseline capacity so something is
// actually schedulable the moment `terraform apply` finishes. Sizing vars are required with
// no default so prod and staging tfvars are forced to set genuinely different values, same
// parameterization pattern as data/variables.tf's min_capacity/max_capacity.

resource "aws_eks_node_group" "baseline" {
  cluster_name           = aws_eks_cluster.this.name
  node_group_name_prefix = "${var.environment}-baseline-"
  node_role_arn          = aws_iam_role.node.arn
  subnet_ids             = var.private_subnet_ids
  launch_template {
    id      = aws_launch_template.baseline.id
    version = aws_launch_template.baseline.latest_version
  }

  instance_types = var.node_instance_types
  capacity_type  = var.node_capacity_type

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    role = "baseline"
  }

  tags = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr,
    aws_iam_role_policy_attachment.node_ssm,
    kubernetes_config_map_v1_data.aws_auth,
  ]

  lifecycle {
    create_before_destroy = true
  }
}

// --- Core addons --------------------------------------------------------------

resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "vpc-cni"

  tags = local.common_tags
}

resource "aws_eks_addon" "coredns" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "coredns"

  depends_on = [aws_eks_node_group.baseline] # CoreDNS pods need somewhere to schedule
  tags       = local.common_tags
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "kube-proxy"

  tags = local.common_tags
}

// Pod Identity — the mechanism architecture-decisions.md §3 names for attaching IAM roles to
// pods. This addon is the one-time cluster-level prerequisite; the actual per-workload
// aws_eks_pod_identity_association resources (ESO's role, etc.) get added once there's a real
// Helm-installed service account to attach them to — Orchestration work building on top of
// this Infrastructure piece, same ownership split as §4.
resource "aws_eks_addon" "pod_identity" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "eks-pod-identity-agent"

  depends_on = [aws_eks_node_group.baseline]
  tags       = local.common_tags
}

// --- Subnet tags for the ingress controller's LB auto-discovery ---------------
// Whatever creates the ingress LB (NGINX ingress controller via Helm, most likely) finds its
// subnets by these tags, not by name. Added here via aws_ec2_tag rather than by editing the
// network module, because the cluster name isn't known until this module runs.
//
// for_each is keyed by list INDEX (0, 1, 2...) rather than the subnet id itself. On a from-
// scratch apply, module.network's subnet ids don't exist yet — they're only known after
// terraform actually creates them — so a set built from the raw id strings can't be resolved
// at plan time. The index is known immediately (the list's length doesn't change), so keying
// on it lets terraform plan cleanly even before any subnet actually exists.

resource "aws_ec2_tag" "public_elb" {
  for_each    = { for idx, id in var.public_subnet_ids : idx => id }
  resource_id = each.value
  key         = "kubernetes.io/role/elb"
  value       = "1"
}

resource "aws_ec2_tag" "private_internal_elb" {
  for_each    = { for idx, id in var.private_subnet_ids : idx => id }
  resource_id = each.value
  key         = "kubernetes.io/role/internal-elb"
  value       = "1"
}

resource "aws_ec2_tag" "public_cluster" {
  for_each    = { for idx, id in var.public_subnet_ids : idx => id }
  resource_id = each.value
  key         = "kubernetes.io/cluster/${local.cluster_name}"
  value       = "shared"
}

resource "aws_ec2_tag" "private_cluster" {
  for_each    = { for idx, id in var.private_subnet_ids : idx => id }
  resource_id = each.value
  key         = "kubernetes.io/cluster/${local.cluster_name}"
  value       = "shared"
}
