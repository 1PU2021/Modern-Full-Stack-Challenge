'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { loadConfig } = require('../../src/shared/config');
const { createDb, createPool } = require('../../src/shared/db');
const { createDispatchStore } = require('../../src/dispatch/store');
const { ensureMigrated, withSuperuserClient } = require('./support/db');

const ids = Object.fromEntries(['tenant', 'user', 'recipient', 'alert', 'delivery'].map((key) => [key, randomUUID()]));
let pool;
let store;

async function reset() {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM alert_outbox; DELETE FROM idempotency_keys; DELETE FROM deliveries; DELETE FROM alerts; DELETE FROM group_members; DELETE FROM groups; DELETE FROM recipients; DELETE FROM users; DELETE FROM tenants');
    await client.query("INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1,'dispatch-store','Dispatch','county_em')", [ids.tenant]);
    await client.query("INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1,$2,'dispatch@test','x')", [ids.user, ids.tenant]);
    await client.query("INSERT INTO recipients (id, tenant_id, name) VALUES ($1,$2,'Recipient')", [ids.recipient, ids.tenant]);
    await client.query("INSERT INTO alerts (id, tenant_id, created_by, title, body, channels, target) VALUES ($1,$2,$3,'Alert','Body',ARRAY['sms'],'{}')", [ids.alert, ids.tenant, ids.user]);
    await client.query("INSERT INTO deliveries (id, tenant_id, alert_id, recipient_id, channel, status, attempt_count) VALUES ($1,$2,$3,$4,'sms','failed',1)", [ids.delivery, ids.tenant, ids.alert, ids.recipient]);
  });
}

const job = () => ({ deliveryId: ids.delivery, alertId: ids.alert, tenantId: ids.tenant, recipientId: ids.recipient, channel: 'sms' });

before(async () => { await ensureMigrated(); pool = createPool(loadConfig().appDatabaseUrl); store = createDispatchStore({ db: createDb(pool), maxAttempts: 3 }); });
beforeEach(reset);
after(async () => pool.end());

test('app_user can retry a prior failure below the cap and terminally record success', async () => {
  const attempt = await store.beginAttempt(job());
  assert.equal(attempt.kind, 'attempt');
  assert.equal(attempt.attemptCount, 2);
  const result = await store.recordOutcome(job(), attempt.attemptCount, { outcome: 'delivered', retryable: false, permanent: false, response: { providerId: 'ok' } });
  assert.deepEqual(result, { terminal: true, status: 'delivered' });
  const row = await withSuperuserClient((client) => client.query('SELECT status, attempt_count FROM deliveries WHERE id=$1', [ids.delivery]));
  assert.deepEqual(row.rows[0], { status: 'delivered', attempt_count: 2 });
});

test('a delivery at the attempt cap is not incremented again', async () => {
  await withSuperuserClient((client) => client.query("UPDATE deliveries SET status='timed_out', attempt_count=3 WHERE id=$1", [ids.delivery]));
  assert.deepEqual(await store.beginAttempt(job()), { kind: 'skip' });
});
