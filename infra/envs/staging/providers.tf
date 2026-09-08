provider "aws" {
  region = "us-east-2"
  # Same as envs/prod — no hardcoded profile. Locally: AWS_PROFILE=terraform-execution.
  # In CI: GitHub Actions supplies credentials via OIDC automatically.
}
