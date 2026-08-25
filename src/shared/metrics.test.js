'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMetrics } = require('./metrics');

test('createMetrics registers all required metrics on an isolated registry', async () => {
  const metrics = createMetrics();
  const text = await metrics.register.metrics();
  assert.match(text, /alert_intake_to_delivery_seconds/);
  assert.match(text, /alert_intake_accepted_total/);
  assert.match(text, /alert_intake_rejected_total/);
  assert.match(text, /dispatch_delivery_outcome_total/);
  assert.match(text, /queue_backlog_depth/);
  assert.match(text, /queue_inflight_messages/);
});

test('intakeAcceptedTotal increments per tenant', async () => {
  const metrics = createMetrics();
  metrics.intakeAcceptedTotal.inc({ tenant_id: 't-1' });
  metrics.intakeAcceptedTotal.inc({ tenant_id: 't-1' });
  const value = await metrics.register.getSingleMetricAsString('alert_intake_accepted_total');
  assert.match(value, /tenant_id="t-1"\} 2/);
});

test('intakeToDeliverySeconds observes durations by channel', async () => {
  const metrics = createMetrics();
  metrics.intakeToDeliverySeconds.observe({ channel: 'sms' }, 1.5);
  const value = await metrics.register.getSingleMetricAsString('alert_intake_to_delivery_seconds');
  assert.match(value, /channel="sms"/);
});

test('deliveryOutcomeTotal is labeled by channel and outcome', async () => {
  const metrics = createMetrics();
  metrics.deliveryOutcomeTotal.inc({ channel: 'email', outcome: 'delivered' });
  const value = await metrics.register.getSingleMetricAsString('dispatch_delivery_outcome_total');
  assert.match(value, /channel="email",outcome="delivered"\} 1/);
});

test('queueBacklogDepth is settable per queue', async () => {
  const metrics = createMetrics();
  metrics.queueBacklogDepth.set({ queue: 'alert-fanout' }, 42);
  const value = await metrics.register.getSingleMetricAsString('queue_backlog_depth');
  assert.match(value, /queue="alert-fanout"\} 42/);
});

test('queueInflightMessages is settable per queue, independently of queueBacklogDepth', async () => {
  const metrics = createMetrics();
  metrics.queueBacklogDepth.set({ queue: 'alert-fanout' }, 5);
  metrics.queueInflightMessages.set({ queue: 'alert-fanout' }, 12);

  const backlogValue = await metrics.register.getSingleMetricAsString('queue_backlog_depth');
  const inflightValue = await metrics.register.getSingleMetricAsString('queue_inflight_messages');
  assert.match(backlogValue, /queue="alert-fanout"\} 5/);
  assert.match(inflightValue, /queue="alert-fanout"\} 12/);
});

test('two createMetrics() calls do not share state', async () => {
  const a = createMetrics();
  const b = createMetrics();
  a.intakeAcceptedTotal.inc({ tenant_id: 't-1' });
  const bValue = await b.register.getSingleMetricAsString('alert_intake_accepted_total');
  assert.doesNotMatch(bValue, /tenant_id="t-1"/);
});
