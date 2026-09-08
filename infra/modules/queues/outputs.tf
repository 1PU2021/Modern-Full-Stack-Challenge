// These map directly onto the app's own env vars:
//   ALERT_FANOUT_QUEUE_URL       = alert_fanout_queue_url
//   RECIPIENT_DISPATCH_QUEUE_URL = recipient_dispatch_queue_url
// (the DLQ URLs aren't consumed by app code — mainly useful for CloudWatch alarms
// watching for anything landing in them)

output "alert_fanout_queue_url" {
  value = aws_sqs_queue.alert_fanout.url
}

output "alert_fanout_queue_arn" {
  value = aws_sqs_queue.alert_fanout.arn
}

output "alert_fanout_dlq_url" {
  value = aws_sqs_queue.alert_fanout_dlq.url
}

output "recipient_dispatch_queue_url" {
  value = aws_sqs_queue.recipient_dispatch.url
}

output "recipient_dispatch_queue_arn" {
  value = aws_sqs_queue.recipient_dispatch.arn
}

output "recipient_dispatch_dlq_url" {
  value = aws_sqs_queue.recipient_dispatch_dlq.url
}
