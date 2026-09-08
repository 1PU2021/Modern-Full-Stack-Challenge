data "aws_iam_policy_document" "github_actions_deploy_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type = "Federated"
      identifiers = [
        "arn:aws:iam::942010118414:oidc-provider/token.actions.githubusercontent.com"
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:Final-Project-greenbean@321209452/Modern-Full-Stack-Challenge@1346749595:ref:refs/heads/main"
      ]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name                 = "github-actions-deploy-role"
  path                 = "/"
  assume_role_policy   = data.aws_iam_policy_document.github_actions_deploy_assume_role.json
  max_session_duration = 3600

  permissions_boundary = "arn:aws:iam::942010118414:policy/boundary-all-engineers"

  tags = {
    "gh-provider-team" = "greenbean-team"
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name = "github-actions-deploy-permissions"
  role = aws_iam_role.github_actions_deploy.name

  policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Sid      = "ECRAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
  "ecr:BatchCheckLayerAvailability",
  "ecr:PutImage",
  "ecr:InitiateLayerUpload",
  "ecr:UploadLayerPart",
  "ecr:CompleteLayerUpload",
  "ecr:BatchGetImage",
  "ecr:DescribeImages"
]
        Resource = [
  "arn:aws:ecr:us-east-2:942010118414:repository/alerts-intake",
  "arn:aws:ecr:us-east-2:942010118414:repository/alerts-fanout",
  "arn:aws:ecr:us-east-2:942010118414:repository/alerts-dispatch"
]
      },
      {
        Sid      = "EKSDescribe"
        Effect   = "Allow"
        Action   = "eks:DescribeCluster"
        Resource = "arn:aws:eks:us-east-2:942010118414:cluster/prod-alerts-eks"
      }
    ]
  })
}
