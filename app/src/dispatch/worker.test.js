'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate } = require('node:timers');
const { createDispatchWorker } = require('./worker');

function metrics() {
  return { queueBacklogDepth: { set() {} }, queueInflightMessages: { set() {} } };
}

test('dispatch worker receives bounded batches and processes sequentially', async () => {
  const seen = [];
  let receive;
  receive = async (options) => { assert.equal(options.maxMessages, 10); assert.equal(options.waitTimeSeconds, 10); assert.equal(options.visibilityTimeout, 60); return [{ id: 1 }, { id: 2 }]; };
  const worker = createDispatchWorker({ receive, process: async (message) => { seen.push(message.id); if (message.id === 2) void worker.stop(); }, getQueueCounts: async () => ({ visible: 0, inFlight: 0 }), metrics: metrics(), logger: { error() {} }, sleep: async () => {} });
  await worker.start();
  assert.deepEqual(seen, [1, 2]);
});

test('dispatch worker logs processing failures and continues', async () => {
  const errors = [];
  let calls = 0;
  let worker;
  worker = createDispatchWorker({
    receive: async () => { calls += 1; if (calls === 1) return [{ id: 1 }, { id: 2 }]; void worker.stop(); return []; },
    process: async (message) => { if (message.id === 1) throw new Error('bad'); },
    getQueueCounts: async () => ({ visible: 0, inFlight: 0 }), metrics: metrics(), logger: { error: (entry) => errors.push(entry) }, sleep: async () => {},
  });
  await worker.start();
  assert.equal(errors.length, 1);
  assert.equal(calls, 2);
});

test('abort cancels an active receive and active processing', async () => {
  let receiveSignal;
  let processSignal;
  let release;
  const processing = new Promise((resolve) => { release = resolve; });
  let worker;
  worker = createDispatchWorker({
    receive: async ({ abortSignal }) => { receiveSignal = abortSignal; return [{ id: 1 }]; },
    process: async (_, { abortSignal }) => { processSignal = abortSignal; await processing; },
    getQueueCounts: async () => ({ visible: 0, inFlight: 0 }), metrics: metrics(), logger: { error() {} }, sleep: async () => {},
  });
  const done = worker.start();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = worker.abort();
  assert.equal(receiveSignal.aborted, true);
  assert.equal(processSignal.aborted, true);
  release();
  await Promise.all([done, stopping]);
});
