data "aws_iam_policy_document" "aws_load_balancer_controller_assume_role" {
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

resource "aws_iam_role" "aws_load_balancer_controller" {
  name                 = "${local.cluster_name}-aws-load-balancer-controller"
  path                 = "/workload/"
  assume_role_policy   = data.aws_iam_policy_document.aws_load_balancer_controller_assume_role.json
  permissions_boundary = "arn:aws:iam::942010118414:policy/terraform-created-role-boundary"

  tags = local.common_tags
}

resource "aws_iam_role_policy" "aws_load_balancer_controller" {
  name = "${local.cluster_name}-aws-load-balancer-controller"
  role = aws_iam_role.aws_load_balancer_controller.id

  policy = file("${path.module}/policies/aws-load-balancer-controller.json")
}

resource "aws_eks_pod_identity_association" "aws_load_balancer_controller" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "kube-system"
  service_account = "aws-load-balancer-controller"
  role_arn        = aws_iam_role.aws_load_balancer_controller.arn

  depends_on = [
    aws_eks_addon.pod_identity
  ]
}
