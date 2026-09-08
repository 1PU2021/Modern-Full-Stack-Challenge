variable "environment" {
  type = string
}

// How long a message stays invisible to other consumers after one worker picks it up.
// Needs to comfortably exceed the worst-case processing time, or a still-in-progress
// message gets redelivered to a second worker while the first one is still on it.
//
// alert-fanout: fanout does a DB/PostGIS query to resolve recipients — fast.
// recipient-dispatch: dispatch calls a provider stub, and the email stub can
// deliberately hang 25-32s (that's the point — it proves the dispatch worker's
// client-side timeout actually fires). Visibility timeout has to clear that or the
// queue will redeliver a message that's still legitimately being handled.
variable "fanout_visibility_timeout_seconds" {
  type    = number
  default = 30
}

variable "dispatch_visibility_timeout_seconds" {
  type    = number
  default = 90
}

// How many times SQS will redeliver a message before giving up and routing it to
// that queue's DLQ. Matches MAX_DELIVERY_ATTEMPTS=5 in the app's env vars — this
// number has to stay in sync with that by hand, since one lives in Terraform and
// the other in application config.
variable "max_receive_count" {
  type    = number
  default = 5
}

// How long SQS keeps a message around before dropping it entirely, if nothing ever
// consumes it successfully. AWS default is 4 days; kept as a variable so staging
// could use a shorter window if that ever matters for cost/cleanup.
variable "message_retention_seconds" {
  type    = number
  default = 345600 // 4 days
}

variable "tags" {
  type    = map(string)
  default = {}
}
