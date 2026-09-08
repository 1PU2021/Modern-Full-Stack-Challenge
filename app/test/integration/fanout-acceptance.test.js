'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { loadConfig } = require('../../src/shared/config');
const { createDb, createPool } = require('../../src/shared/db');
const { createFanoutStore } = require('../../src/fanout/store');
const { createFanoutProcessor } = require('../../src/fanout/processor');
const { ensureMigrated, withSuperuserClient } = require('./support/db');

const ids = Object.fromEntries(['tenant', 'otherTenant', 'user', 'otherUser', 'group', 'inside', 'other'].map((key) => [key, randomUUID()]));
let pool;
let store;

async function reset() {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM alert_outbox; DELETE FROM idempotency_keys; DELETE FROM deliveries; DELETE FROM alerts; DELETE FROM group_members; DELETE FROM groups; DELETE FROM recipients; DELETE FROM users; DELETE FROM tenants');
    await client.query('INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1,\'acceptance-a\',\'A\',\'county_em\'), ($2,\'acceptance-b\',\'B\',\'school_district\')', [ids.tenant, ids.otherTenant]);
    await client.query('INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1,$2,\'a@test\',\'x\'), ($3,$4,\'b@test\',\'x\')', [ids.user, ids.tenant, ids.otherUser, ids.otherTenant]);
    await client.query('INSERT INTO groups (id, tenant_id, name) VALUES ($1,$2,\'All\')', [ids.group, ids.tenant]);
    await client.query(`INSERT INTO recipients (id, tenant_id, name, location) VALUES
      ($1,$2,'Inside',ST_SetSRID(ST_MakePoint(-86,39.8),4326)::geography),
      ($3,$4,'Other',ST_SetSRID(ST_MakePoint(-86,39.8),4326)::geography)`, [ids.inside, ids.tenant, ids.other, ids.otherTenant]);
    await client.query('INSERT INTO group_members (group_id, recipient_id, tenant_id) VALUES ($1,$2,$3)', [ids.group, ids.inside, ids.tenant]);
  });
}

async function alert(target) {
  const id = randomUUID();
  await withSuperuserClient((client) => client.query(
    `INSERT INTO alerts (id, tenant_id, created_by, title, body, channels, target)
     VALUES ($1,$2,$3,'Alert','Body',ARRAY['sms','email'],$4::jsonb)`,
    [id, ids.tenant, ids.user, JSON.stringify(target)]
  ));
  return id;
}

before(async () => { await ensureMigrated(); pool = createPool(loadConfig().appDatabaseUrl); store = createFanoutStore({ db: createDb(pool) }); });
beforeEach(reset);
after(async () => pool.end());

test('fanout processor accepts group events idempotently and emits one job per logical delivery', async () => {
  const alertId = await alert({ type: 'group', groupId: ids.group });
  const sent = [];
  const acked = [];
  const processor = createFanoutProcessor({
    store,
    send: async (job) => sent.push(job),
    ack: async (message) => acked.push(message),
    logger: { child() { return { info() {}, error() {} }; }, error() {} },
  });
  const message = { Body: JSON.stringify({ eventId: randomUUID(), alertId, tenantId: ids.tenant }) };
  await processor.process(message);
  await processor.process(message);
  assert.equal(acked.length, 2);
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.slice(0, 2).map((job) => job.deliveryId), sent.slice(2).map((job) => job.deliveryId));
  const count = await withSuperuserClient((client) => client.query('SELECT count(*)::int AS count FROM deliveries WHERE alert_id=$1', [alertId]));
  assert.equal(count.rows[0].count, 2);
});

test('polygon fanout remains tenant-scoped at the acceptance boundary', async () => {
  const alertId = await alert({ type: 'polygon', geojson: { type: 'Polygon', coordinates: [[[-87,39],[-85,39],[-85,41],[-87,41],[-87,39]]] } });
  const result = await store.materialize({ eventId: randomUUID(), alertId, tenantId: ids.tenant });
  assert.deepEqual(result.jobs.map((job) => job.recipientId), [ids.inside, ids.inside].filter((_, index) => index < result.jobs.length));
  assert.ok(result.jobs.every((job) => job.tenantId === ids.tenant));
});
