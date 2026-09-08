provider "aws" {
  region = "us-east-2"
  # No hardcoded profile here on purpose: locally, set AWS_PROFILE=terraform-execution
  # in your shell before running terraform; in CI, GitHub Actions supplies credentials
  # via OIDC through environment variables automatically. Hardcoding a personal
  # profile name here would only work for you and would break the pipeline.
}

data "aws_eks_cluster" "this" {
  name = "${var.environment}-alerts-eks"
}

provider "kubernetes" {
  host                   = data.aws_eks_cluster.this.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", data.aws_eks_cluster.this.name, "--region", "us-east-2"]
  }
}
