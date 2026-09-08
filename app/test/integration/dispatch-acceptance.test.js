'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { loadConfig } = require('../../src/shared/config');
const { createDb, createPool } = require('../../src/shared/db');
const { createFanoutStore } = require('../../src/fanout/store');
const { createDispatchStore } = require('../../src/dispatch/store');
const { createDispatchProcessor } = require('../../src/dispatch/processor');
const { createProviderClient } = require('../../src/dispatch/providers');
const { createStubApp } = require('../../src/stubs/app');
const { ensureMigrated, withSuperuserClient } = require('./support/db');

const ids = Object.fromEntries(['tenant', 'user', 'group', 'recipient'].map((key) => [key, randomUUID()]));
let pool;
let db;
let fanout;

async function reset() {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM alert_outbox; DELETE FROM idempotency_keys; DELETE FROM deliveries; DELETE FROM alerts; DELETE FROM group_members; DELETE FROM groups; DELETE FROM recipients; DELETE FROM users; DELETE FROM tenants');
    await client.query("INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1,'dispatch-acceptance','Acceptance','county_em')", [ids.tenant]);
    await client.query("INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1,$2,'acceptance@test','x')", [ids.user, ids.tenant]);
    await client.query("INSERT INTO groups (id, tenant_id, name) VALUES ($1,$2,'Acceptance group')", [ids.group, ids.tenant]);
    await client.query("INSERT INTO recipients (id, tenant_id, name) VALUES ($1,$2,'Acceptance recipient')", [ids.recipient, ids.tenant]);
    await client.query('INSERT INTO group_members (group_id, recipient_id, tenant_id) VALUES ($1,$2,$3)', [ids.group, ids.recipient, ids.tenant]);
  });
}

async function insertAlert() {
  const alertId = randomUUID();
  await withSuperuserClient((client) => client.query(
    `INSERT INTO alerts (id, tenant_id, created_by, title, body, channels, target)
     VALUES ($1,$2,$3,'Acceptance','Body',ARRAY['sms'],$4::jsonb)`,
    [alertId, ids.tenant, ids.user, JSON.stringify({ type: 'group', groupId: ids.group })]
  ));
  return alertId;
}

before(async () => { await ensureMigrated(); pool = createPool(loadConfig().appDatabaseUrl); db = createDb(pool); fanout = createFanoutStore({ db }); });
beforeEach(reset);
after(async () => pool.end());

test('accepted alert flows through fanout, HTTP provider stub, and delivered outcome', async () => {
  const alertId = await insertAlert();
  const materialized = await fanout.materialize({ eventId: randomUUID(), alertId, tenantId: ids.tenant });
  assert.equal(materialized.jobs.length, 1);

  let calls = 0;
  const stub = createStubApp({ channel: 'sms', personality: { handle: async () => { calls += 1; return { status: 202, body: { providerId: 'stub-1' } }; } } });
  const server = await new Promise((resolve) => { const value = stub.listen(0, () => resolve(value)); });
  const port = server.address().port;
  const provider = createProviderClient({ urls: { sms: `http://127.0.0.1:${port}/sms/send`, email: `http://127.0.0.1:${port}/sms/send` }, timeoutMs: 1000 });
  const metrics = { deliveryOutcomeTotal: { inc() {} }, intakeToDeliverySeconds: { observe() {} } };
  let acknowledged = 0;
  const processor = createDispatchProcessor({ store: createDispatchStore({ db, maxAttempts: 3 }), providers: provider, ack: async () => { acknowledged += 1; }, metrics, logger: { child() { return { info() {}, error() {} }; }, error() {} } });
  await processor.process({ Body: JSON.stringify(materialized.jobs[0]) });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(calls, 1);
  assert.equal(acknowledged, 1);
  const row = await withSuperuserClient((client) => client.query('SELECT status, attempt_count FROM deliveries WHERE id=$1', [materialized.jobs[0].deliveryId]));
  assert.deepEqual(row.rows[0], { status: 'delivered', attempt_count: 1 });
});

test('retryable provider failure reaches terminal failed at max attempts', async () => {
  const alertId = await insertAlert();
  const materialized = await fanout.materialize({ eventId: randomUUID(), alertId, tenantId: ids.tenant });
  let acknowledged = 0;
  const processor = createDispatchProcessor({
    store: createDispatchStore({ db, maxAttempts: 1 }),
    providers: { send: async () => ({ outcome: 'failed', retryable: true, permanent: false, response: { reason: 'stub' } }) },
    ack: async () => { acknowledged += 1; },
    metrics: { deliveryOutcomeTotal: { inc() {} }, intakeToDeliverySeconds: { observe() {} } },
    logger: { child() { return { info() {}, error() {} }; }, error() {} },
  });
  await processor.process({ Body: JSON.stringify(materialized.jobs[0]) });
  assert.equal(acknowledged, 1);
  const row = await withSuperuserClient((client) => client.query('SELECT status, attempt_count FROM deliveries WHERE id=$1', [materialized.jobs[0].deliveryId]));
  assert.deepEqual(row.rows[0], { status: 'failed', attempt_count: 1 });
});
