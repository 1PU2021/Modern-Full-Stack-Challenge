'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startDispatch } = require('./index');

test('startDispatch binds configured dispatch queue and provider URLs', () => {
  const calls = [];
  const server = { on() {}, close(callback) { callback(); } };
  const worker = { start() { calls.push('worker.start'); }, stop: async () => {}, abort: async () => {} };
  const deps = {
    loadConfig: () => ({ port: 3100, logLevel: 'silent', appDatabaseUrl: 'db', aws: {}, queues: { recipientDispatchUrl: 'dispatch' }, providers: { smsUrl: 'sms', emailUrl: 'email' }, maxDeliveryAttempts: 5 }),
    createLogger: () => ({ info() {}, error() {}, child() { return this; } }),
    createMetrics: () => ({ register: {}, deliveryOutcomeTotal: {}, intakeToDeliverySeconds: {}, queueBacklogDepth: {}, queueInflightMessages: {} }),
    createPool: () => ({ end: async () => {} }),
    createDb: (pool) => ({ pool, withTenant: async () => {} }),
    createQueueClient: () => ({ destroy() {} }),
    createProviderClient: (options) => { calls.push(options.urls); return { send() {} }; },
    createDispatchStore: () => ({}),
    createDispatchProcessor: () => ({ process() {} }),
    createDispatchWorker: () => worker,
    createOpsApp: () => ({ listen(port, callback) { calls.push(`listen:${port}`); callback(); return server; } }),
    createReadiness: () => ({ beginShutdown() {}, isShuttingDown: () => false }),
    createShutdownCoordinator: () => ({ shutdown() {}, force() {} }),
    receiveMessages: async () => [],
    deleteMessage: async () => {},
    getQueueCounts: async () => ({ visible: 0, inFlight: 0 }),
  };
  const result = startDispatch(deps);
  assert.deepEqual(calls, [{ sms: 'sms', email: 'email' }, 'listen:3100', 'worker.start']);
  assert.ok(result.server);
});
