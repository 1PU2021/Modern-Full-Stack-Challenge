terraform {
  backend "s3" {
    # The S3 bucket Caleb provisioned specifically for Terraform state,
    # confirmed final via the IAM permission set JSON we reviewed earlier.
    bucket = "aug-final-prj-tf-bucket"
    # Where inside that bucket this environment's state file lives — each
    # environment needs its own key so prod and staging never overwrite
    # each other's state.
    key = "prod/terraform.tfstate"
    # Matches the account's region lock — required regardless, since every
    # resource this config creates has to live in us-east-2 anyway.
    region = "us-east-2"
    # S3-native state locking (Terraform 1.10+) — this is what stops two
    # people from running `terraform apply` at the same moment and
    # corrupting the state file.
    # UNCONFIRMED — if the team is actually using a DynamoDB lock table
    # instead, replace this line with: dynamodb_table = "<table-name>"
    use_lockfile = true
  }
}
