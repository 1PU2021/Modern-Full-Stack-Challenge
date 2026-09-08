'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { loadConfig } = require('../../src/shared/config');
const { createDb, createPool } = require('../../src/shared/db');
const { createFanoutStore } = require('../../src/fanout/store');
const { PermanentFanoutError } = require('../../src/fanout/schemas');
const { ensureMigrated, withSuperuserClient } = require('./support/db');

const ids = Object.fromEntries([
  'tenantA', 'tenantB', 'userA', 'userB', 'groupA', 'recipient1', 'recipient2',
  'recipientBoundary', 'recipientOutside', 'recipientNull', 'recipientB', 'recipientDeactivated',
].map((key) => [key, randomUUID()]));
let pool;
let store;

async function reset() {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM alert_outbox; DELETE FROM idempotency_keys; DELETE FROM deliveries; DELETE FROM alerts; DELETE FROM group_members; DELETE FROM groups; DELETE FROM recipients; DELETE FROM users; DELETE FROM tenants');
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES
       ($1,'fanout-a','A','county_em'), ($2,'fanout-b','B','school_district')`,
      [ids.tenantA, ids.tenantB]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash) VALUES
       ($1,$2,'a@fanout.test','x'), ($3,$4,'b@fanout.test','x')`,
      [ids.userA, ids.tenantA, ids.userB, ids.tenantB]
    );
    await client.query('INSERT INTO groups (id, tenant_id, name) VALUES ($1,$2,$3)',
      [ids.groupA, ids.tenantA, 'Primary']);
    await client.query(
      `INSERT INTO recipients (id, tenant_id, name, location) VALUES
       ($1,$2,'Inside 1',ST_SetSRID(ST_MakePoint(-86.0,39.8),4326)::geography),
       ($3,$2,'Inside 2',ST_SetSRID(ST_MakePoint(-86.1,39.9),4326)::geography),
       ($4,$2,'Boundary',ST_SetSRID(ST_MakePoint(-86.5,39.5),4326)::geography),
       ($5,$2,'Outside',ST_SetSRID(ST_MakePoint(-88,41),4326)::geography),
       ($6,$2,'No location',NULL),
       ($7,$8,'Other tenant',ST_SetSRID(ST_MakePoint(-86.0,39.8),4326)::geography)`,
      [ids.recipient1, ids.tenantA, ids.recipient2, ids.recipientBoundary,
        ids.recipientOutside, ids.recipientNull, ids.recipientB, ids.tenantB]
    );
    // Same location as "Inside 1" and also a group member, so it's a
    // meaningful negative case for BOTH targeting paths: geographically and
    // by membership it qualifies, but must still be excluded from future
    // targeting once deactivated.
    await client.query(
      `INSERT INTO recipients (id, tenant_id, name, location, deactivated_at) VALUES
       ($1,$2,'Deactivated',ST_SetSRID(ST_MakePoint(-86.0,39.8),4326)::geography,now())`,
      [ids.recipientDeactivated, ids.tenantA]
    );
    await client.query(
      `INSERT INTO group_members (group_id, recipient_id, tenant_id) VALUES
       ($1,$2,$3), ($1,$4,$3), ($1,$5,$3)`,
      [ids.groupA, ids.recipient1, ids.tenantA, ids.recipient2, ids.recipientDeactivated]
    );
  });
}

async function insertAlert({ tenantId = ids.tenantA, userId = ids.userA, target, channels = ['sms', 'email'] }) {
  const alertId = randomUUID();
  await withSuperuserClient((client) => client.query(
    `INSERT INTO alerts (id, tenant_id, created_by, title, body, channels, target)
     VALUES ($1,$2,$3,'Fanout','Body',$4,$5::jsonb)`,
    [alertId, tenantId, userId, channels, JSON.stringify(target)]
  ));
  return alertId;
}

function event(alertId, tenantId = ids.tenantA) {
  return { eventId: randomUUID(), alertId, tenantId };
}

before(async () => {
  await ensureMigrated();
  pool = createPool(loadConfig().appDatabaseUrl);
  store = createFanoutStore({ db: createDb(pool) });
});
beforeEach(reset);
after(async () => pool.end());

test('group fanout creates the ordered recipient/channel cross-product, excluding deactivated members', async () => {
  const alertId = await insertAlert({ target: { type: 'group', groupId: ids.groupA } });
  const result = await store.materialize(event(alertId));
  assert.equal(result.state, 'dispatching');
  assert.equal(result.jobs.length, 4);
  assert.deepEqual(new Set(result.jobs.map((job) => job.recipientId)),
    new Set([ids.recipient1, ids.recipient2]));
  assert.equal(
    result.jobs.some((job) => job.recipientId === ids.recipientDeactivated), false,
    'a deactivated recipient must be excluded from group targeting even though it is still a group member'
  );
  assert.deepEqual(new Set(result.jobs.map((job) => job.channel)), new Set(['sms', 'email']));
  for (const job of result.jobs) {
    assert.deepEqual(Object.keys(job), ['deliveryId', 'alertId', 'tenantId', 'recipientId', 'channel']);
    assert.equal(job.alertId, alertId);
    assert.equal(job.tenantId, ids.tenantA);
  }
});

test('empty or missing groups complete without deliveries', async () => {
  const alertId = await insertAlert({ target: { type: 'group', groupId: randomUUID() } });
  const result = await store.materialize(event(alertId));
  assert.deepEqual(result, { state: 'completed', jobs: [] });
  const row = await withSuperuserClient((client) => client.query(
    'SELECT status, completed_at FROM alerts WHERE id = $1', [alertId]
  ));
  assert.equal(row.rows[0].status, 'completed');
  assert.ok(row.rows[0].completed_at);
});

test('polygon fanout uses strict containment, excludes null, other tenants, and deactivated recipients', async () => {
  const target = {
    type: 'polygon',
    geojson: {
      type: 'Polygon',
      coordinates: [[[-86.5,39.5],[-85.5,39.5],[-85.5,40.5],[-86.5,40.5],[-86.5,39.5]]],
    },
  };
  const alertId = await insertAlert({ target, channels: ['sms'] });
  const result = await store.materialize(event(alertId));
  assert.deepEqual(new Set(result.jobs.map((job) => job.recipientId)),
    new Set([ids.recipient1, ids.recipient2]));
  assert.equal(
    result.jobs.some((job) => job.recipientId === ids.recipientDeactivated), false,
    'a deactivated recipient must be excluded from polygon targeting even though it is geographically inside the shape'
  );
});

test('duplicate and concurrent materialization retain one stable logical job set', async () => {
  const alertId = await insertAlert({ target: { type: 'group', groupId: ids.groupA } });
  const [first, second] = await Promise.all([
    store.materialize(event(alertId)), store.materialize(event(alertId)),
  ]);
  const third = await store.materialize(event(alertId));
  const identities = (result) => result.jobs.map((job) => job.deliveryId).sort();
  assert.deepEqual(identities(second), identities(first));
  assert.deepEqual(identities(third), identities(first));
  const count = await withSuperuserClient((client) => client.query(
    'SELECT count(*)::int count FROM deliveries WHERE alert_id = $1', [alertId]
  ));
  assert.equal(count.rows[0].count, 4);
});

test('cross-tenant and nonexistent alerts are indistinguishable permanent misses', async () => {
  const hidden = await insertAlert({
    tenantId: ids.tenantB,
    userId: ids.userB,
    target: { type: 'group', groupId: randomUUID() },
  });
  for (const alertId of [hidden, randomUUID()]) {
    await assert.rejects(
      () => store.materialize(event(alertId)),
      (error) => error instanceof PermanentFanoutError && error.reason === 'alert_not_found'
    );
  }
});

test('invalid PostGIS geometry is permanent and rolls back partial state', async () => {
  const target = {
    type: 'polygon',
    geojson: {
      type: 'Polygon',
      coordinates: [[[-86.5,39.5],[-85.5,40.5],[-86.5,40.5],[-85.5,39.5],[-86.5,39.5]]],
    },
  };
  const alertId = await insertAlert({ target });
  await assert.rejects(
    () => store.materialize(event(alertId)),
    (error) => error instanceof PermanentFanoutError && error.reason === 'invalid_geometry'
  );
  const rows = await withSuperuserClient((client) => client.query(
    'SELECT status, (SELECT count(*)::int FROM deliveries WHERE alert_id=$1) count FROM alerts WHERE id=$1',
    [alertId]
  ));
  assert.deepEqual(rows.rows[0], { status: 'accepted', count: 0 });
  assert.equal(await store.markFailed(event(alertId), 'invalid_geometry'), true);
});
