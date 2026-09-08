// External Secrets Operator IAM role and EKS Pod Identity association.
//
// ESO will use this role to read only the production application secrets
// required by workloads in the alerts-prod namespace.

data "aws_iam_policy_document" "external_secrets_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    actions = [
      "sts:AssumeRole",
      "sts:TagSession",
    ]
  }
}

data "aws_iam_policy_document" "keda_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    actions = [
      "sts:AssumeRole",
      "sts:TagSession",
    ]
  }
}

resource "aws_iam_role" "keda" {
  name                 = "${local.cluster_name}-keda"
  path                 = "/workload/"
  assume_role_policy   = data.aws_iam_policy_document.keda_assume_role.json
  permissions_boundary = "arn:aws:iam::942010118414:policy/terraform-created-role-boundary"

  tags = local.common_tags
}

data "aws_iam_policy_document" "keda" {
  statement {
    sid    = "ReadQueueDepth"
    effect = "Allow"

    actions = [
      "sqs:GetQueueAttributes",
    ]

    resources = [
      "arn:aws:sqs:us-east-2:942010118414:prod-alert-fanout",
      "arn:aws:sqs:us-east-2:942010118414:prod-recipient-dispatch",
    ]
  }
}

resource "aws_iam_role_policy" "keda" {
  name   = "${local.cluster_name}-keda"
  role   = aws_iam_role.keda.id
  policy = data.aws_iam_policy_document.keda.json
}

resource "aws_eks_pod_identity_association" "keda" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "keda"
  service_account = "keda-operator"
  role_arn        = aws_iam_role.keda.arn

  depends_on = [
    aws_eks_addon.pod_identity
  ]
}

data "aws_iam_policy_document" "intake_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    actions = [
      "sts:AssumeRole",
      "sts:TagSession",
    ]
  }
}

data "aws_iam_policy_document" "fanout_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    actions = [
      "sts:AssumeRole",
      "sts:TagSession",
    ]
  }
}

resource "aws_iam_role" "fanout" {
  name                 = "${local.cluster_name}-fanout"
  path                 = "/workload/"
  assume_role_policy   = data.aws_iam_policy_document.fanout_assume_role.json
  permissions_boundary = "arn:aws:iam::942010118414:policy/terraform-created-role-boundary"

  tags = local.common_tags
}

data "aws_iam_policy_document" "fanout" {
  statement {
    sid    = "FanoutQueueAccess"
    effect = "Allow"

    actions = [
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]

    resources = [
      "arn:aws:sqs:us-east-2:942010118414:prod-alert-fanout",
      "arn:aws:sqs:us-east-2:942010118414:prod-recipient-dispatch",
    ]
  }
}

data "aws_iam_policy_document" "dispatch_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    actions = [
      "sts:AssumeRole",
      "sts:TagSession",
    ]
  }
}

resource "aws_iam_role" "dispatch" {
  name                 = "${local.cluster_name}-dispatch"
  path                 = "/workload/"
  assume_role_policy   = data.aws_iam_policy_document.dispatch_assume_role.json
  permissions_boundary = "arn:aws:iam::942010118414:policy/terraform-created-role-boundary"

  tags = local.common_tags
}

data "aws_iam_policy_document" "dispatch" {
  statement {
    sid    = "DispatchQueueAccess"
    effect = "Allow"

    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]

    resources = [
      "arn:aws:sqs:us-east-2:942010118414:prod-recipient-dispatch",
    ]
  }
}

resource "aws_iam_role_policy" "dispatch" {
  name   = "${local.cluster_name}-dispatch"
  role   = aws_iam_role.dispatch.id
  policy = data.aws_iam_policy_document.dispatch.json
}

resource "aws_eks_pod_identity_association" "dispatch" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "alerts-prod"
  service_account = "dispatch"
  role_arn        = aws_iam_role.dispatch.arn

  depends_on = [
    aws_eks_addon.pod_identity
  ]
}

resource "aws_iam_role_policy" "fanout" {
  name   = "${local.cluster_name}-fanout"
  role   = aws_iam_role.fanout.id
  policy = data.aws_iam_policy_document.fanout.json
}

resource "aws_eks_pod_identity_association" "fanout" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "alerts-prod"
  service_account = "fanout"
  role_arn        = aws_iam_role.fanout.arn

  depends_on = [
    aws_eks_addon.pod_identity
  ]
}

resource "aws_iam_role" "intake" {
  name                 = "${local.cluster_name}-intake"
  path                 = "/workload/"
  assume_role_policy   = data.aws_iam_policy_document.intake_assume_role.json
  permissions_boundary = "arn:aws:iam::942010118414:policy/terraform-created-role-boundary"

  tags = local.common_tags
}

data "aws_iam_policy_document" "intake" {
  statement {
    sid    = "SendAlertFanout"
    effect = "Allow"

    actions = [
      "sqs:SendMessage"
    ]

    resources = [
      "arn:aws:sqs:us-east-2:942010118414:prod-alert-fanout"
    ]
  }
}

resource "aws_iam_role_policy" "intake" {
  name   = "${local.cluster_name}-intake"
  role   = aws_iam_role.intake.id
  policy = data.aws_iam_policy_document.intake.json
}

resource "aws_eks_pod_identity_association" "intake" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "alerts-prod"
  service_account = "intake"
  role_arn        = aws_iam_role.intake.arn

  depends_on = [
    aws_eks_addon.pod_identity
  ]
}

resource "aws_iam_role" "external_secrets" {
  name               = "${local.cluster_name}-external-secrets"
  path               = "/workload/"
  assume_role_policy = data.aws_iam_policy_document.external_secrets_assume_role.json

  tags = local.common_tags
}

data "aws_iam_policy_document" "external_secrets" {
  statement {
    sid    = "ReadAlertsSecrets"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [
      "arn:aws:secretsmanager:us-east-2:942010118414:secret:prod/alerts/app-db-*",
      "arn:aws:secretsmanager:us-east-2:942010118414:secret:prod/alerts/app-runtime-*",
    ]
  }
}

resource "aws_iam_role_policy" "external_secrets" {
  name   = "${local.cluster_name}-external-secrets"
  role   = aws_iam_role.external_secrets.id
  policy = data.aws_iam_policy_document.external_secrets.json
}

resource "aws_eks_pod_identity_association" "external_secrets" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "external-secrets"
  service_account = "external-secrets"
  role_arn        = aws_iam_role.external_secrets.arn

  depends_on = [
    aws_eks_addon.pod_identity
  ]
}