// The exact bucket name the whole team's already agreed on and referenced in
// backend.tf — kept as a variable here too so it's one source of truth, not
// hardcoded twice in two different files that could drift apart.
variable "bucket_name" {
  type    = string
  default = "aug-final-prj-tf-bucket"
}

variable "region" {
  type    = string
  default = "us-east-2"
}

variable "tags" {
  type    = map(string)
  default = {}
}

// The one AWS account this config should ever be allowed to touch — the
// shared training account, per team-role-phase-plan.md. Guards against
// exactly what just happened: silently applying under whatever ambient
// default credential chain is active (e.g. a personal account) instead
// of the intended one.
variable "expected_account_id" {
  description = "The only AWS account this bootstrap config should ever apply to."
  type        = string
  default     = "942010118414"
}
