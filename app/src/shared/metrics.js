'use strict';

const client = require('prom-client');

function createMetrics() {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  const intakeToDeliverySeconds = new client.Histogram({
    name: 'alert_intake_to_delivery_seconds',
    help: 'Time from alert intake acceptance to a delivery reaching a terminal state',
    labelNames: ['channel'],
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [register],
  });

  const intakeAcceptedTotal = new client.Counter({
    name: 'alert_intake_accepted_total',
    help: 'Count of alerts accepted at intake',
    labelNames: ['tenant_id'],
    registers: [register],
  });

  const intakeRejectedTotal = new client.Counter({
    name: 'alert_intake_rejected_total',
    help: 'Count of alerts rejected at intake validation',
    labelNames: ['reason'],
    registers: [register],
  });

  const deliveryOutcomeTotal = new client.Counter({
    name: 'dispatch_delivery_outcome_total',
    help: 'Count of delivery attempts by terminal outcome',
    labelNames: ['channel', 'outcome'],
    registers: [register],
  });

  const queueBacklogDepth = new client.Gauge({
    name: 'queue_backlog_depth',
    help: 'Approximate number of visible messages waiting in a queue',
    labelNames: ['queue'],
    registers: [register],
  });

  const queueInflightMessages = new client.Gauge({
    name: 'queue_inflight_messages',
    help: 'Approximate number of in-flight messages in a queue (received but not yet deleted or visible)',
    labelNames: ['queue'],
    registers: [register],
  });

  return {
    register,
    intakeToDeliverySeconds,
    intakeAcceptedTotal,
    intakeRejectedTotal,
    deliveryOutcomeTotal,
    queueBacklogDepth,
    queueInflightMessages,
  };
}

module.exports = { createMetrics };
