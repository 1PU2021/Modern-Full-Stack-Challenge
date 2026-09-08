terraform {
  backend "s3" {
    # Same state bucket as envs/prod — Caleb provisioned one bucket for all
    # environments, distinguished by key below, not by separate buckets.
    bucket = "aug-final-prj-tf-bucket"
    # Own key so staging's state file never collides with prod's
    # ("prod/terraform.tfstate") — see envs/prod/backend.tf for that side.
    key    = "staging/terraform.tfstate"
    region = "us-east-2"
    # Same native S3 locking as envs/prod — UNCONFIRMED, see that file's
    # identical note. If the team ends up on a DynamoDB lock table instead,
    # both envs/prod and envs/staging need this line swapped together.
    use_lockfile = true
  }
}
