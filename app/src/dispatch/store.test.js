'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { createDispatchStore } = require('./store');
const { PermanentDispatchError } = require('./schemas');

function harness(row) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT id, tenant_id, alert_id')) return { rows: row ? [row] : [] };
      if (sql.includes('SELECT count(*)')) return { rows: [{ count: '0' }] };
      return { rowCount: 1, rows: [] };
    },
  };
  const db = { withTenant: async (tenantId, fn) => fn(client, tenantId) };
  return { store: createDispatchStore({ db, maxAttempts: 3 }), queries };
}

function job() {
  return { deliveryId: randomUUID(), alertId: randomUUID(), tenantId: randomUUID(), recipientId: randomUUID(), channel: 'sms' };
}

test('beginAttempt increments a retryable prior failure below the cap', async () => {
  const input = job();
  const { store, queries } = harness({ ...input, id: input.deliveryId, status: 'failed', attempt_count: 1, created_at: new Date().toISOString() });
  const result = await store.beginAttempt(input);
  assert.equal(result.kind, 'attempt');
  assert.equal(result.attemptCount, 2);
  assert.ok(queries.some((query) => query.sql.includes('FOR UPDATE')));
  assert.ok(queries.some((query) => query.sql.includes('attempt_count = attempt_count + 1')));
});

test('beginAttempt skips delivered and exhausted rows', async () => {
  const delivered = job();
  const first = harness({ ...delivered, id: delivered.deliveryId, status: 'delivered', attempt_count: 1 });
  assert.deepEqual(await first.store.beginAttempt(delivered), { kind: 'skip' });
  const exhausted = job();
  const second = harness({ ...exhausted, id: exhausted.deliveryId, status: 'timed_out', attempt_count: 3 });
  assert.deepEqual(await second.store.beginAttempt(exhausted), { kind: 'skip' });
});

test('beginAttempt turns a missing or mismatched delivery into a permanent error', async () => {
  const input = job();
  const { store } = harness(null);
  await assert.rejects(() => store.beginAttempt(input), (error) => error instanceof PermanentDispatchError && error.reason === 'delivery_not_found');
});

test('recordOutcome stores a retryable result and leaves delivery eligible', async () => {
  const input = job();
  const { store, queries } = harness({ ...input, id: input.deliveryId, status: 'pending', attempt_count: 1, created_at: new Date().toISOString() });
  const result = await store.recordOutcome(input, 1, { outcome: 'rate_limited', retryable: true, permanent: false, response: { retryAfter: 2 } });
  assert.deepEqual(result, { terminal: false, status: 'rate_limited' });
  assert.ok(queries.some((query) => query.sql.includes("status = $3")));
});

test('recordOutcome marks an exhausted failure terminal and never regresses delivered', async () => {
  const input = job();
  const { store, queries } = harness({ ...input, id: input.deliveryId, status: 'pending', attempt_count: 3, created_at: new Date().toISOString() });
  const result = await store.recordOutcome(input, 3, { outcome: 'failed', retryable: true, permanent: false, response: { reason: 'upstream' } });
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'failed');
  assert.ok(queries.some((query) => query.sql.includes('status <> \'delivered\'')));
});

test('permanent provider failures remain terminal even below the retry cap', async () => {
  const input = job();
  const { store, queries } = harness({ ...input, id: input.deliveryId, status: 'pending', attempt_count: 1, provider_response: null });
  const result = await store.recordOutcome(input, 1, { outcome: 'failed', retryable: false, permanent: true, response: { reason: 'invalid' } });
  assert.equal(result.terminal, true);
  assert.ok(queries.some((query) => query.sql.includes("provider_response->>'permanent'")));
});
