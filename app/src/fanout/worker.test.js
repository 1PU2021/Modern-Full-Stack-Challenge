'use strict';

const assert = require('node:assert/strict');
const { setImmediate } = require('node:timers');
const { test } = require('node:test');
const { createFanoutWorker } = require('./worker');

const logger = { info() {}, error() {} };

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('receives bounded long polls and processes a batch sequentially', async () => {
  const options = [];
  const processed = [];
  let worker;
  worker = createFanoutWorker({
    receive: async (value) => {
      options.push(value);
      return [{ Body: 'one' }, { Body: 'two' }];
    },
    process: async (message) => {
      processed.push(message.Body);
      if (processed.length === 2) void worker.stop();
    },
    getQueueCounts: async () => ({ visible: 0, inFlight: 0 }),
    metrics: { queueBacklogDepth: { set() {} }, queueInflightMessages: { set() {} } },
    logger,
  });
  worker.start();
  await worker.done;
  assert.deepEqual(processed, ['one', 'two']);
  assert.equal(options[0].maxMessages, 10);
  assert.equal(options[0].waitTimeSeconds, 10);
  assert.equal(options[0].visibilityTimeout, 60);
  assert.ok(options[0].abortSignal);
});

test('processing failure is logged and the next message can continue', async () => {
  const errors = [];
  let receives = 0;
  let worker;
  worker = createFanoutWorker({
    receive: async () => (++receives === 1 ? [{ Body: 'bad' }] : []),
    process: async () => { if (receives === 1) throw new Error('retryable'); },
    getQueueCounts: async () => ({ visible: 0, inFlight: 0 }),
    metrics: { queueBacklogDepth: { set() {} }, queueInflightMessages: { set() {} } },
    logger: { error(fields, message) { errors.push([fields, message]); }, info() {} },
    sleep: async () => { void worker.stop(); },
  });
  worker.start();
  await worker.done;
  assert.equal(errors.length, 1);
  assert.equal(receives, 2);
});

test('queue counts update both bounded queue labels', async () => {
  const gauges = [];
  let worker;
  worker = createFanoutWorker({
    receive: async () => [],
    process: async () => {},
    getQueueCounts: async (queue) => (queue === 'alert-fanout'
      ? { visible: 3, inFlight: 4 } : { visible: 5, inFlight: 6 }),
    metrics: {
      queueBacklogDepth: { set(labels, value) { gauges.push(['backlog', labels.queue, value]); } },
      queueInflightMessages: { set(labels, value) { gauges.push(['inflight', labels.queue, value]); } },
    },
    logger,
    sleep: async () => { void worker.stop(); },
  });
  worker.start();
  await worker.done;
  assert.deepEqual(gauges, [
    ['backlog', 'alert-fanout', 3], ['inflight', 'alert-fanout', 4],
    ['backlog', 'recipient-dispatch', 5], ['inflight', 'recipient-dispatch', 6],
  ]);
});

test('stop interrupts idle polling and waits for active processing', async () => {
  let release;
  const active = new Promise((resolve) => { release = resolve; });
  let worker;
  const started = new Promise((resolve) => {
    worker = createFanoutWorker({
      receive: async () => [{ Body: 'active' }],
      process: async () => { resolve(); await active; },
      getQueueCounts: async () => ({ visible: 0, inFlight: 0 }),
      metrics: { queueBacklogDepth: { set() {} }, queueInflightMessages: { set() {} } },
      logger,
    });
  });
  worker.start();
  await started;
  const stopping = worker.stop();
  await tick();
  release();
  await stopping;
});

test('abort cancels an active receive and resolves without processing', async () => {
  let signal;
  let processed = 0;
  const worker = createFanoutWorker({
    receive: async (options) => {
      signal = options.abortSignal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
      }));
    },
    process: async () => { processed += 1; },
    getQueueCounts: async () => ({ visible: 0, inFlight: 0 }),
    metrics: { queueBacklogDepth: { set() {} }, queueInflightMessages: { set() {} } },
    logger,
  });
  worker.start();
  await tick();
  await worker.abort();
  assert.equal(signal.aborted, true);
  assert.equal(processed, 0);
});

test('abort cancels active processing instead of acknowledging it', async () => {
  let signal;
  let worker;
  const processingStarted = new Promise((resolve) => {
    worker = createFanoutWorker({
      receive: async () => [{ Body: 'active' }],
      process: async (message, options) => {
        void message;
        signal = options.abortSignal;
        resolve();
        return new Promise((resolveProcess, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
          });
          void resolveProcess;
        });
      },
      getQueueCounts: async () => ({ visible: 0, inFlight: 0 }),
      metrics: { queueBacklogDepth: { set() {} }, queueInflightMessages: { set() {} } },
      logger,
    });
  });
  worker.start();
  await processingStarted;
  await worker.abort();
  assert.equal(signal.aborted, true);
});
