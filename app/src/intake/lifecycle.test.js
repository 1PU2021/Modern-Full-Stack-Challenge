'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShutdownCoordinator } = require('./lifecycle');

function harness(overrides = {}) {
  const calls = [];
  let timer;
  const values = {
    readiness: { beginShutdown: () => calls.push('unready') },
    publisher: {
      stop: async () => calls.push('publisher.stop'),
      abort: async () => calls.push('publisher.abort'),
    },
    server: {
      close(callback) { calls.push('server.close'); callback(); },
      closeIdleConnections() { calls.push('server.closeIdle'); },
      closeAllConnections() { calls.push('server.closeAll'); },
    },
    pool: { end: async () => calls.push('pool.end') },
    queueClient: { destroy: () => calls.push('queue.destroy') },
    logger: { error: (...args) => calls.push(['log.error', ...args]) },
    graceMs: 25_000,
    forceExit: (code) => calls.push(['exit', code]),
    setTimer: (fn, ms) => { timer = { fn, ms }; return timer; },
    clearTimer: () => { timer = undefined; },
    ...overrides,
  };
  return {
    calls,
    coordinator: createShutdownCoordinator(values),
    fireTimer() { timer.fn(); },
    timer: () => timer,
  };
}

test('normal shutdown drains HTTP and publisher before resources without forced exit', async () => {
  const h = harness();
  await h.coordinator.shutdown();
  assert.deepEqual(h.calls, [
    'unready', 'publisher.stop', 'server.close', 'pool.end', 'queue.destroy',
  ]);
  assert.equal(h.timer(), undefined);
});

test('concurrent shutdown calls share cleanup and one promise', async () => {
  let release;
  const stopping = new Promise((resolve) => { release = resolve; });
  const h = harness({ publisher: { stop: () => stopping, abort: async () => {} } });
  const first = h.coordinator.shutdown();
  const second = h.coordinator.shutdown();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(h.calls.filter((call) => call === 'unready').length, 1);
});

test('deadline aborts the send, closes lingering sockets, cleans up, and exits nonzero', async () => {
  const never = new Promise(() => {});
  const h = harness({ publisher: { stop: () => never, abort: async () => h.calls.push('publisher.abort') } });
  const shutdown = h.coordinator.shutdown();
  assert.equal(h.timer().ms, 25_000);
  h.fireTimer();
  await shutdown;
  assert.deepEqual(h.calls.slice(-6), [
    'publisher.abort', 'server.closeIdle', 'server.closeAll', 'pool.end',
    'queue.destroy', ['exit', 1],
  ]);
});

test('force immediately exits for a second signal', () => {
  const h = harness();
  h.coordinator.force();
  assert.deepEqual(h.calls, [['exit', 1]]);
});

test('cleanup rejection is logged and forces nonzero exit', async () => {
  const h = harness({ pool: { end: async () => { throw new Error('pool failed'); } } });
  await h.coordinator.shutdown();
  assert.equal(h.calls.at(-1)[0], 'exit');
  assert.equal(h.calls.at(-1)[1], 1);
  assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === 'log.error'), true);
});
