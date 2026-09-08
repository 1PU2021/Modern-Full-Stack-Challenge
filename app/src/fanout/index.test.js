'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startFanout } = require('./index');

function dependencies() {
  const calls = [];
  const server = {
    on() {},
    close(callback) { callback(); },
  };
  const worker = {
    start() { calls.push('worker.start'); },
    stop() { calls.push('worker.stop'); return Promise.resolve(); },
    abort() { calls.push('worker.abort'); return Promise.resolve(); },
  };
  const coordinator = { shutdown() {}, force() {} };
  return {
    calls,
    loadConfig: () => ({ port: 3000, logLevel: 'silent', appDatabaseUrl: 'db', aws: {}, jwtSecret: 'secret', queues: { alertFanoutUrl: 'fanout', recipientDispatchUrl: 'dispatch' } }),
    createLogger: () => ({ info() {}, error() {}, child() { return this; } }),
    createMetrics: () => ({ register: { contentType: 'text/plain', metrics: async () => '' }, queueBacklogDepth: { set() {} }, queueInflightMessages: { set() {} } }),
    createPool: () => ({ end: async () => {} }),
    createDb: (pool) => ({ pool, withTenant: async () => {} }),
    createQueueClient: () => ({ destroy() {} }),
    createOpsApp: () => ({ listen(port, callback) { calls.push(`listen:${port}`); callback(); return server; } }),
    createReadiness: () => ({ beginShutdown() {}, isShuttingDown: () => false }),
    createFanoutStore: () => ({}),
    createFanoutProcessor: () => ({}),
    createFanoutWorker: () => worker,
    createShutdownCoordinator: () => coordinator,
    receiveMessages: async () => [],
    sendMessage: async () => {},
    deleteMessage: async () => {},
    getQueueCounts: async () => ({ visible: 0, inFlight: 0 }),
  };
}

test('startFanout composes adapters and starts the worker', () => {
  const deps = dependencies();
  const result = startFanout(deps);
  assert.ok(result.server);
  assert.deepEqual(deps.calls, ['listen:3000', 'worker.start']);
});

test('fanout queue adapters bind the configured queues and bounded receive', async () => {
  const deps = dependencies();
  const received = [];
  deps.receiveMessages = async (...args) => { received.push(args); return []; };
  const result = startFanout(deps);
  await result.receive({ maxMessages: 10, waitTimeSeconds: 10, visibilityTimeout: 60 });
  assert.deepEqual(received[0], [result.queueClient, 'fanout', { maxMessages: 10, waitTimeSeconds: 10, visibilityTimeout: 60 }]);
});
