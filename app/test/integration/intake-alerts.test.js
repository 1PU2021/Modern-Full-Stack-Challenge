'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const request = require('supertest');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const { createIntakeFixture } = require('./support/intake');

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
let fixture;

const body = {
  title: 'Storm warning',
  body: 'Seek shelter now',
  priority: 'critical',
  channels: ['email', 'sms'],
  target: { type: 'group', groupId: randomUUID() },
};

async function clearRows() {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM alert_outbox');
    await client.query('DELETE FROM idempotency_keys');
    await client.query('DELETE FROM deliveries');
    await client.query('DELETE FROM alerts');
    await client.query('DELETE FROM group_members');
    await client.query('DELETE FROM groups');
    await client.query('DELETE FROM recipients');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM tenants');
    await client.query(
      `INSERT INTO tenants (id, name, slug, tenant_type)
       VALUES ($1, $2, $3, 'county_em'), ($4, $5, $6, 'school_district')`,
      [tenantA, 'Tenant A', 'tenant-a', tenantB, 'Tenant B', 'tenant-b']
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash)
       VALUES ($1, $2, 'a@example.test', 'x'), ($3, $4, 'b@example.test', 'x')`,
      [userA, tenantA, userB, tenantB]
    );
  });
}

async function counts() {
  return withSuperuserClient(async (client) => {
    const result = await client.query(`SELECT
      (SELECT count(*)::int FROM alerts) alerts,
      (SELECT count(*)::int FROM idempotency_keys) keys,
      (SELECT count(*)::int FROM alert_outbox) outbox`);
    return result.rows[0];
  });
}

function post(tenantId = tenantA, userId = userA) {
  return request(fixture.app)
    .post('/api/v1/alerts')
    .set('Authorization', `Bearer ${fixture.sign({ tenantId, userId })}`);
}

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture();
});
beforeEach(clearRows);
after(async () => fixture?.pool.end());

test('accepts an alert atomically and creates the exact durable event', async () => {
  const response = await post().send(body).expect(202);
  assert.match(response.body.alertId, /^[0-9a-f-]{36}$/);
  assert.match(response.body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(response.body.replayed, false);
  assert.deepEqual(await counts(), { alerts: 1, keys: 1, outbox: 1 });
  const row = await withSuperuserClient(async (client) =>
    client.query('SELECT id, payload FROM alert_outbox'));
  assert.deepEqual(row.rows[0].payload, {
    eventId: row.rows[0].id,
    alertId: response.body.alertId,
    tenantId: tenantA,
  });
});

test('equivalent retries, including reversed channels, replay without new rows', async () => {
  const key = 'same-operation';
  const first = await post().set('Idempotency-Key', key).send(body).expect(202);
  const replay = await post().set('Idempotency-Key', key)
    .send({ ...body, channels: ['sms', 'email'] }).expect(202);
  assert.deepEqual(replay.body, { ...first.body, replayed: true });
  assert.deepEqual(await counts(), { alerts: 1, keys: 1, outbox: 1 });
});

test('reusing a key for changed content, channels, or target conflicts', async () => {
  const key = 'conflict';
  await post().set('Idempotency-Key', key).send(body).expect(202);
  for (const changed of [
    { ...body, title: 'Different' },
    { ...body, channels: ['sms'] },
    { ...body, target: { type: 'group', groupId: randomUUID() } },
  ]) {
    const response = await post().set('Idempotency-Key', key).send(changed).expect(409);
    assert.equal(response.body.error.code, 'idempotency_key_reused');
  }
  assert.deepEqual(await counts(), { alerts: 1, keys: 1, outbox: 1 });
});

test('concurrent same-key requests converge on one accepted alert', async () => {
  const key = 'concurrent';
  const responses = await Promise.all([
    post().set('Idempotency-Key', key).send(body),
    post().set('Idempotency-Key', key).send(body),
  ]);
  assert.deepEqual(responses.map((item) => item.status).sort(), [202, 202]);
  assert.equal(responses[0].body.alertId, responses[1].body.alertId);
  assert.deepEqual(responses.map((item) => item.body.replayed).sort(), [false, true]);
  assert.deepEqual(await counts(), { alerts: 1, keys: 1, outbox: 1 });
});

test('validation and nonexistent users leave no partial rows or SQL details', async () => {
  const invalid = await post().send({ ...body, channels: [] }).expect(400);
  assert.equal(invalid.body.error.code, 'validation_failed');
  const missing = await post(tenantA, randomUUID()).send(body).expect(500);
  assert.equal(missing.body.error.code, 'internal_error');
  assert.doesNotMatch(JSON.stringify(missing.body), /insert|constraint|users/i);
  assert.deepEqual(await counts(), { alerts: 0, keys: 0, outbox: 0 });
});

test('idempotency keys are isolated by tenant', async () => {
  const key = 'tenant-local';
  const a = await post().set('Idempotency-Key', key).send(body).expect(202);
  const b = await post(tenantB, userB).set('Idempotency-Key', key).send(body).expect(202);
  assert.notEqual(a.body.alertId, b.body.alertId);
  assert.deepEqual(await counts(), { alerts: 2, keys: 2, outbox: 2 });
});
