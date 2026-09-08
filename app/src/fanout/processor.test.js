'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AbortController } = globalThis;
const { createFanoutProcessor } = require('./processor');
const { PermanentFanoutError } = require('./schemas');

function message(body) {
  return { Body: typeof body === 'string' ? body : JSON.stringify(body), ReceiptHandle: 'r-1' };
}

function event() {
  return { eventId: randomUUID(), alertId: randomUUID(), tenantId: randomUUID() };
}

const logger = { child(fields) { return { fields, info() {}, error() {} }; }, info() {}, error() {} };

test('materializes before publishing jobs and acknowledges after all sends', async () => {
  const input = event();
  const jobs = [
    { deliveryId: randomUUID(), alertId: input.alertId, tenantId: input.tenantId, recipientId: randomUUID(), channel: 'sms' },
    { deliveryId: randomUUID(), alertId: input.alertId, tenantId: input.tenantId, recipientId: randomUUID(), channel: 'email' },
  ];
  const order = [];
  const sent = [];
  let acknowledged = 0;
  const processor = createFanoutProcessor({
    store: {
      async materialize(value) { order.push(['materialize', value]); return { state: 'dispatching', jobs }; },
      async markFailed() { assert.fail('unexpected markFailed'); },
    },
    async send(job) { order.push(['send', job]); sent.push(job); },
    async ack() { order.push(['ack']); acknowledged += 1; },
    logger,
  });
  await processor.process(message(input));
  assert.deepEqual(sent, jobs);
  assert.equal(acknowledged, 1);
  assert.equal(order.at(-1)[0], 'ack');
});

test('completed materialization acknowledges without publishing', async () => {
  let sends = 0;
  let acks = 0;
  const processor = createFanoutProcessor({
    store: { materialize: async () => ({ state: 'completed', jobs: [] }), markFailed: async () => {} },
    send: async () => { sends += 1; },
    ack: async () => { acks += 1; },
    logger,
  });
  await processor.process(message(event()));
  assert.equal(sends, 0);
  assert.equal(acks, 1);
});

test('send failure leaves the input unacknowledged and is retryable', async () => {
  let acks = 0;
  const failure = new Error('queue unavailable');
  const processor = createFanoutProcessor({
    store: { materialize: async () => ({ state: 'dispatching', jobs: [{ deliveryId: randomUUID() }] }), markFailed: async () => {} },
    send: async () => { throw failure; },
    ack: async () => { acks += 1; },
    logger,
  });
  await assert.rejects(() => processor.process(message(event())), (error) => error === failure);
  assert.equal(acks, 0);
});

test('abort leaves the input unacknowledged', async () => {
  const controller = new AbortController();
  let acks = 0;
  const processor = createFanoutProcessor({
    store: { materialize: async () => ({ state: 'dispatching', jobs: [{ deliveryId: randomUUID() }] }), markFailed: async () => {} },
    send: async () => {
      controller.abort();
      const error = new Error('aborted'); error.name = 'AbortError'; throw error;
    },
    ack: async () => { acks += 1; },
    logger,
  });
  await assert.rejects(() => processor.process(message(event()), { abortSignal: controller.signal }));
  assert.equal(acks, 0);
});

test('permanent materialization errors mark the alert and acknowledge', async () => {
  const input = event();
  let marked;
  let acks = 0;
  const processor = createFanoutProcessor({
    store: {
      async materialize() { throw new PermanentFanoutError('invalid_geometry', 'Invalid alert geometry'); },
      async markFailed(value, reason) { marked = [value, reason]; },
    },
    send: async () => assert.fail('unexpected send'),
    ack: async () => { acks += 1; },
    logger,
  });
  await processor.process(message(input));
  assert.equal(marked[0].alertId, input.alertId);
  assert.equal(marked[1], 'invalid_geometry');
  assert.equal(acks, 1);
});

test('malformed input acknowledges without logging the raw body', async () => {
  const raw = 'private-alert-body';
  const logs = [];
  let acks = 0;
  const processor = createFanoutProcessor({
    store: { materialize: async () => assert.fail('unexpected materialize'), markFailed: async () => {} },
    send: async () => assert.fail('unexpected send'),
    ack: async () => { acks += 1; },
    logger: { error(...args) { logs.push(args); }, child: () => logger },
  });
  await processor.process(message(raw));
  assert.equal(acks, 1);
  assert.doesNotMatch(JSON.stringify(logs), /private-alert-body/);
});
