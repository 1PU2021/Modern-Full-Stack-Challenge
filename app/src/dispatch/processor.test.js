'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { createDispatchProcessor } = require('./processor');

function baseJob() {
  return { deliveryId: randomUUID(), alertId: randomUUID(), tenantId: randomUUID(), recipientId: randomUUID(), channel: 'sms' };
}

function harness(begin, providerResult) {
  const calls = { ack: 0, outcome: [], metric: [], latency: [] };
  const job = baseJob();
  const processor = createDispatchProcessor({
    store: {
      beginAttempt: async () => begin,
      recordOutcome: async (...args) => { calls.outcome.push(args); return { terminal: providerResult.outcome === 'delivered' || providerResult.permanent || begin.attemptCount >= 3, status: providerResult.outcome }; },
    },
    providers: { send: async () => providerResult },
    ack: async () => { calls.ack += 1; },
    metrics: {
      deliveryOutcomeTotal: { inc: (labels) => calls.metric.push(labels) },
      intakeToDeliverySeconds: { observe: (labels, value) => calls.latency.push({ labels, value }) },
    },
    logger: { child() { return { info() {}, error() {} }; }, error() {} },
    now: () => 2_000,
  });
  return { processor, job, calls };
}

test('processor records and acknowledges a delivered job', async () => {
  const provider = { outcome: 'delivered', retryable: false, permanent: false, response: { id: 'p1' } };
  const { processor, job, calls } = harness({ kind: 'attempt', attemptCount: 1, delivery: { created_at: new Date(1_000).toISOString() } }, provider);
  await processor.process({ Body: JSON.stringify(job) });
  assert.equal(calls.ack, 1);
  assert.equal(calls.outcome[0][1], 1);
  assert.deepEqual(calls.metric[0], { channel: 'sms', outcome: 'delivered' });
  assert.equal(calls.latency[0].labels.channel, 'sms');
});

test('retryable failure below cap records outcome but leaves message unacknowledged', async () => {
  const provider = { outcome: 'rate_limited', retryable: true, permanent: false, response: { retryAfter: 1 } };
  const { processor, job, calls } = harness({ kind: 'attempt', attemptCount: 1, delivery: {} }, provider);
  await processor.process({ Body: JSON.stringify(job) });
  assert.equal(calls.ack, 0);
  assert.equal(calls.outcome[0][1], 1);
  assert.deepEqual(calls.metric[0], { channel: 'sms', outcome: 'rate_limited' });
});

test('permanent failure and exhausted retry are acknowledged', async () => {
  const permanent = { outcome: 'failed', retryable: false, permanent: true, response: { reason: 'bad request' } };
  const first = harness({ kind: 'attempt', attemptCount: 1, delivery: {} }, permanent);
  await first.processor.process({ Body: JSON.stringify(first.job) });
  assert.equal(first.calls.ack, 1);
  const exhausted = { outcome: 'failed', retryable: true, permanent: false, response: {} };
  const second = harness({ kind: 'attempt', attemptCount: 3, delivery: {} }, exhausted);
  await second.processor.process({ Body: JSON.stringify(second.job) });
  assert.equal(second.calls.ack, 1);
});

test('delivered and malformed messages are acknowledged without provider calls', async () => {
  const provider = { outcome: 'delivered', retryable: false, permanent: false, response: {} };
  const { processor, calls } = harness({ kind: 'skip' }, provider);
  await processor.process({ Body: '{}' });
  assert.equal(calls.ack, 1);
});
