// Two standard SQS queues carrying the pipeline: intake -> alert-fanout -> fanout
// service -> recipient-dispatch -> dispatch service. Each gets its own dead-letter
// queue rather than sharing one DLQ between them — that way a failed message's
// origin queue is obvious just from which DLQ it landed in, without needing to
// inspect the message body.
//
// Standard queues, not FIFO — matches the brief's own reasoning: FIFO caps out around
// 3k msg/s with batching, too low for a burst test, and ordering safety comes from
// idempotency keys in the app instead of queue-level ordering.

locals {
  common_tags = merge(var.tags, {
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "queues"
  })
}

// ============================================================================
// alert-fanout — intake writes here, fanout service consumes
// ============================================================================
resource "aws_sqs_queue" "alert_fanout_dlq" {
  name                      = "${var.environment}-alert-fanout-dlq"
  message_retention_seconds = var.message_retention_seconds
  sqs_managed_sse_enabled   = true
  tags                      = merge(local.common_tags, { Queue = "alert-fanout-dlq" })
}

resource "aws_sqs_queue" "alert_fanout" {
  name                       = "${var.environment}-alert-fanout"
  visibility_timeout_seconds = var.fanout_visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds
  sqs_managed_sse_enabled    = true
  // After max_receive_count failed processing attempts, SQS stops redelivering to
  // this queue and routes the message to the DLQ instead — that's the "retry/backoff
  // for free from the queue" behavior the spec describes.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.alert_fanout_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
  tags = merge(local.common_tags, { Queue = "alert-fanout" })
}

// ============================================================================
// recipient-dispatch — fanout writes here (one message per recipient per channel),
// dispatch service consumes
// ============================================================================
resource "aws_sqs_queue" "recipient_dispatch_dlq" {
  name                      = "${var.environment}-recipient-dispatch-dlq"
  message_retention_seconds = var.message_retention_seconds
  sqs_managed_sse_enabled   = true
  tags                      = merge(local.common_tags, { Queue = "recipient-dispatch-dlq" })
}

resource "aws_sqs_queue" "recipient_dispatch" {
  name                       = "${var.environment}-recipient-dispatch"
  visibility_timeout_seconds = var.dispatch_visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.recipient_dispatch_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
  tags = merge(local.common_tags, { Queue = "recipient-dispatch" })
}
