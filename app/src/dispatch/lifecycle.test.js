'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createShutdownCoordinator } = require('./lifecycle');

function fixture() {
  const calls = [];
  const server = { close(callback) { calls.push('server.close'); callback(); }, closeIdleConnections() { calls.push('idle'); }, closeAllConnections() { calls.push('all'); } };
  const worker = { stop: async () => calls.push('worker.stop'), abort: async () => calls.push('worker.abort') };
  const pool = { end: async () => calls.push('pool.end') };
  const queueClient = { destroy: () => calls.push('queue.destroy') };
  const readiness = { beginShutdown: () => calls.push('not-ready') };
  return { calls, server, worker, pool, queueClient, readiness };
}

test('graceful shutdown drains dispatch resources', async () => {
  const f = fixture();
  const coordinator = createShutdownCoordinator({ ...f, logger: { error() {} }, forceExit: () => { throw new Error('forced'); }, setTimer: (fn) => ({ unref() {}, fn }), clearTimer() {} });
  await coordinator.shutdown();
  assert.deepEqual(f.calls, ['not-ready', 'worker.stop', 'server.close', 'pool.end', 'queue.destroy']);
});

test('second signal force path exits immediately', () => {
  const f = fixture();
  let code;
  const coordinator = createShutdownCoordinator({ ...f, logger: { error() {} }, forceExit: (value) => { code = value; } });
  coordinator.force();
  assert.equal(code, 1);
});
