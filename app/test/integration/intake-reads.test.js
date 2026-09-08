'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const request = require('supertest');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const { createIntakeFixture } = require('./support/intake');

const ids = Object.fromEntries([
  'tenantA', 'tenantB', 'userA', 'userB', 'alertA', 'alertEmpty', 'alertB',
  'groupA', 'groupEmpty', 'groupB', 'recipientAmy', 'recipientZed', 'delivery1', 'delivery2',
].map((name) => [name, randomUUID()]));
let fixture;
let tokenA;

async function seed() {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM alert_outbox; DELETE FROM idempotency_keys; DELETE FROM deliveries; DELETE FROM alerts; DELETE FROM group_members; DELETE FROM groups; DELETE FROM recipients; DELETE FROM users; DELETE FROM tenants');
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES
       ($1, 'read-a', 'A', 'county_em'), ($2, 'read-b', 'B', 'school_district')`,
      [ids.tenantA, ids.tenantB]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash) VALUES
       ($1, $2, 'a@read.test', 'x'), ($3, $4, 'b@read.test', 'x')`,
      [ids.userA, ids.tenantA, ids.userB, ids.tenantB]
    );
    await client.query(
      `INSERT INTO groups (id, tenant_id, name) VALUES
       ($1, $2, 'Alpha'), ($3, $2, 'Empty'), ($4, $5, 'Hidden')`,
      [ids.groupA, ids.tenantA, ids.groupEmpty, ids.groupB, ids.tenantB]
    );
    await client.query(
      `INSERT INTO recipients (id, tenant_id, name) VALUES
       ($1, $2, 'Amy'), ($3, $2, 'Zed')`,
      [ids.recipientAmy, ids.tenantA, ids.recipientZed]
    );
    await client.query(
      `INSERT INTO group_members (group_id, recipient_id, tenant_id) VALUES ($1, $2, $3)`,
      [ids.groupA, ids.recipientAmy, ids.tenantA]
    );
    const target = JSON.stringify({ type: 'group', groupId: ids.groupA });
    await client.query(
      `INSERT INTO alerts
       (id, tenant_id, created_by, title, body, priority, channels, target, accepted_at)
       VALUES
       ($1,$2,$3,'Older','Body','normal',ARRAY['sms'],$4::jsonb,'2026-01-01T00:00:00Z'),
       ($5,$2,$3,'Newer','Body','high',ARRAY['sms','email'],$4::jsonb,'2026-01-02T00:00:00Z'),
       ($6,$7,$8,'Hidden','Body','normal',ARRAY['sms'],$4::jsonb,'2026-01-03T00:00:00Z')`,
      [ids.alertEmpty, ids.tenantA, ids.userA, target, ids.alertA, ids.alertB, ids.tenantB, ids.userB]
    );
    await client.query(
      `INSERT INTO deliveries
       (id, tenant_id, alert_id, recipient_id, channel, status, attempt_count)
       VALUES ($1,$2,$3,$4,'sms','delivered',2), ($5,$2,$3,$6,'email','pending',0)`,
      [ids.delivery1, ids.tenantA, ids.alertA, ids.recipientZed,
        ids.delivery2, ids.recipientAmy]
    );
  });
}

function get(path) {
  return request(fixture.app).get(path).set('Authorization', `Bearer ${tokenA}`);
}

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture();
  tokenA = fixture.sign({ tenantId: ids.tenantA, userId: ids.userA });
  await seed();
});
after(async () => fixture.pool.end());

test('lists only tenant alerts newest first with exact fields', async () => {
  const response = await get('/api/v1/alerts').expect(200);
  assert.deepEqual(response.body.map((row) => row.id), [ids.alertA, ids.alertEmpty]);
  assert.deepEqual(Object.keys(response.body[0]), [
    'id', 'title', 'priority', 'status', 'channels', 'acceptedAt', 'completedAt',
  ]);
});

test('detail returns stable numeric delivery counts and empty counts', async () => {
  const detail = await get(`/api/v1/alerts/${ids.alertA}`).expect(200);
  assert.deepEqual(detail.body.deliveryCounts, [
    { status: 'pending', count: 1 }, { status: 'delivered', count: 1 },
  ]);
  assert.equal(typeof detail.body.deliveryCounts[0].count, 'number');
  const empty = await get(`/api/v1/alerts/${ids.alertEmpty}`).expect(200);
  assert.deepEqual(empty.body.deliveryCounts, []);
});

test('deliveries have numeric attempts and deterministic recipient ordering', async () => {
  const response = await get(`/api/v1/alerts/${ids.alertA}/deliveries`).expect(200);
  assert.deepEqual(response.body.map((row) => row.recipientName), ['Amy', 'Zed']);
  assert.deepEqual(response.body.map((row) => row.attemptCount), [0, 2]);
});

test('groups include empty groups, numeric counts, and tenant ordering', async () => {
  const response = await get('/api/v1/groups').expect(200);
  assert.deepEqual(response.body, [
    { id: ids.groupA, name: 'Alpha', memberCount: 1 },
    { id: ids.groupEmpty, name: 'Empty', memberCount: 0 },
  ]);
});

test('invalid, missing, and cross-tenant alert IDs have stable errors', async () => {
  const invalid = await get('/api/v1/alerts/nope').expect(400);
  assert.equal(invalid.body.error.code, 'validation_failed');
  const missingId = randomUUID();
  for (const suffix of ['', '/deliveries']) {
    const missing = await get(`/api/v1/alerts/${missingId}${suffix}`).expect(404);
    const hidden = await get(`/api/v1/alerts/${ids.alertB}${suffix}`).expect(404);
    assert.deepEqual(hidden.body, missing.body);
    assert.deepEqual(missing.body, { error: { code: 'not_found', message: 'Alert not found' } });
  }
});
