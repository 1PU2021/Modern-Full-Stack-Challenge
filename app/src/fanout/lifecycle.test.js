'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShutdownCoordinator } = require('./lifecycle');

function harness(overrides = {}) {
  const calls = [];
  let timer;
  const values = {
    readiness: { beginShutdown: () => calls.push('unready') },
    worker: { stop: async () => calls.push('worker.stop'), abort: async () => calls.push('worker.abort') },
    server: {
      close(callback) { calls.push('server.close'); callback(); },
      closeIdleConnections() { calls.push('server.idle'); },
      closeAllConnections() { calls.push('server.all'); },
    },
    pool: { end: async () => calls.push('pool.end') },
    queueClient: { destroy: () => calls.push('queue.destroy') },
    logger: { error: (...args) => calls.push(['error', ...args]) },
    graceMs: 25_000,
    forceExit: (code) => calls.push(['exit', code]),
    setTimer: (fn, ms) => { timer = { fn, ms }; return timer; },
    clearTimer: () => { timer = undefined; },
    ...overrides,
  };
  return { calls, timer: () => timer, fire: () => timer.fn(), coordinator: createShutdownCoordinator(values) };
}

test('normal shutdown drains worker/server before pool and SQS', async () => {
  const value = harness();
  await value.coordinator.shutdown();
  assert.deepEqual(value.calls, ['unready', 'worker.stop', 'server.close', 'pool.end', 'queue.destroy']);
});

test('concurrent shutdown calls share one promise', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const value = harness({ worker: { stop: () => wait, abort: async () => {} } });
  const first = value.coordinator.shutdown();
  const second = value.coordinator.shutdown();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(value.calls.filter((item) => item === 'unready').length, 1);
});

test('deadline aborts worker, closes sockets, starts cleanup, and exits 1', async () => {
  const value = harness({ worker: { stop: () => new Promise(() => {}), abort: async () => value.calls.push('worker.abort') } });
  const shutdown = value.coordinator.shutdown();
  assert.equal(value.timer().ms, 25_000);
  value.fire();
  await shutdown;
  assert.deepEqual(value.calls.slice(-6), [
    'worker.abort', 'server.idle', 'server.all', 'pool.end', 'queue.destroy', ['exit', 1],
  ]);
});

test('force exits immediately and cleanup errors force exit 1', async () => {
  const forced = harness();
  forced.coordinator.force();
  assert.deepEqual(forced.calls, [['exit', 1]]);
  const failed = harness({ pool: { end: async () => { throw new Error('failed'); } } });
  await failed.coordinator.shutdown();
  assert.deepEqual(failed.calls.at(-1), ['exit', 1]);
});
