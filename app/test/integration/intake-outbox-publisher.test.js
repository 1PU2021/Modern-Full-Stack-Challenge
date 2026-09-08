'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const request = require('supertest');
const { loadConfig } = require('../../src/shared/config');
const { createDb, createPool } = require('../../src/shared/db');
const { createOutboxPublisher, createOutboxStore } = require('../../src/intake/outbox');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const { createIntakeFixture } = require('./support/intake');

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const alertA = randomUUID();
const alertB = randomUUID();
let pool;
let store;

async function reset() {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM alert_outbox; DELETE FROM idempotency_keys; DELETE FROM deliveries; DELETE FROM alerts; DELETE FROM group_members; DELETE FROM groups; DELETE FROM recipients; DELETE FROM users; DELETE FROM tenants');
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES
       ($1, 'outbox-a', 'A', 'county_em'), ($2, 'outbox-b', 'B', 'school_district')`,
      [tenantA, tenantB]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash) VALUES
       ($1,$2,'a@outbox.test','x'), ($3,$4,'b@outbox.test','x')`,
      [userA, tenantA, userB, tenantB]
    );
    const target = JSON.stringify({ type: 'group', groupId: randomUUID() });
    await client.query(
      `INSERT INTO alerts (id, tenant_id, created_by, title, body, channels, target)
       VALUES ($1,$2,$3,'A','A',ARRAY['sms'],$4), ($5,$6,$7,'B','B',ARRAY['sms'],$4)`,
      [alertA, tenantA, userA, target, alertB, tenantB, userB]
    );
  });
}

async function insertOutbox({ tenantId = tenantA, alertId = alertA, attemptCount = 0 } = {}) {
  const id = randomUUID();
  await withSuperuserClient((client) => client.query(
    `INSERT INTO alert_outbox (id, tenant_id, alert_id, payload, attempt_count)
     VALUES ($1,$2,$3,$4::jsonb,$5)`,
    [id, tenantId, alertId, JSON.stringify({ eventId: id, alertId, tenantId }), attemptCount]
  ));
  return id;
}

before(async () => {
  await ensureMigrated();
  pool = createPool(loadConfig().appDatabaseUrl);
  store = createOutboxStore({ db: createDb(pool) });
});
beforeEach(reset);
after(async () => pool.end());

test('lists root tenant IDs and claims one row with a UUID 60-second lease', async () => {
  const id = await insertOutbox();
  assert.deepEqual(await store.listTenantIds(), [tenantA, tenantB].sort());
  const claim = await store.claimNext(tenantA);
  assert.equal(claim.id, id);
  assert.match(claim.claimToken, /^[0-9a-f-]{36}$/);
  assert.ok(claim.claimedUntil.getTime() - Date.now() > 59_000);
  assert.equal(await store.claimNext(tenantA), null);
});

test('expired leases are reclaimed with a different token', async () => {
  const id = await insertOutbox();
  const first = await store.claimNext(tenantA);
  await withSuperuserClient((client) => client.query(
    `UPDATE alert_outbox SET claimed_until = now() - interval '1 second' WHERE id = $1`, [id]
  ));
  const second = await store.claimNext(tenantA);
  assert.equal(second.id, id);
  assert.notEqual(second.claimToken, first.claimToken);
});

test('matching success publishes and stale tokens cannot update', async () => {
  const id = await insertOutbox();
  const claim = await store.claimNext(tenantA);
  assert.equal(await store.recordSuccess({ ...claim, claimToken: randomUUID() }), false);
  assert.equal(await store.recordSuccess(claim), true);
  const row = await withSuperuserClient((client) => client.query(
    'SELECT published_at, claim_token, claimed_until FROM alert_outbox WHERE id = $1', [id]
  ));
  assert.ok(row.rows[0].published_at);
  assert.equal(row.rows[0].claim_token, null);
  assert.equal(row.rows[0].claimed_until, null);
});

test('matching failure records capped backoff and truncates Unicode errors', async () => {
  const id = await insertOutbox({ attemptCount: 7 });
  const claim = await store.claimNext(tenantA);
  assert.equal(await store.recordFailure(claim, new Error('😀'.repeat(1_001))), true);
  const row = await withSuperuserClient((client) => client.query(
    `SELECT attempt_count, last_error, claim_token,
            extract(epoch FROM (available_at - created_at)) AS delay
     FROM alert_outbox WHERE id = $1`, [id]
  ));
  assert.equal(row.rows[0].attempt_count, 8);
  assert.equal(Array.from(row.rows[0].last_error).length, 1_000);
  assert.equal(row.rows[0].claim_token, null);
  assert.ok(Number(row.rows[0].delay) >= 59 && Number(row.rows[0].delay) <= 61);
});

test('tenant scope prevents cross-tenant claim and result updates', async () => {
  await insertOutbox({ tenantId: tenantB, alertId: alertB });
  assert.equal(await store.claimNext(tenantA), null);
  const claim = await store.claimNext(tenantB);
  assert.equal(await store.recordSuccess({ ...claim, tenantId: tenantA }), false);
  assert.equal(await store.recordFailure({ ...claim, tenantId: tenantA }, new Error('x')), false);
  assert.equal(await store.recordSuccess(claim), true);
});

test('accepted alerts publish asynchronously once and replay without another event', async () => {
  const intake = createIntakeFixture();
  const key = 'async-boundary';
  const token = intake.sign({ tenantId: tenantA, userId: userA });
  const alertBody = {
    title: 'Async alert',
    body: 'Persist before publish',
    channels: ['sms'],
    target: { type: 'group', groupId: randomUUID() },
  };
  const accepted = await request(intake.app)
    .post('/api/v1/alerts')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(alertBody)
    .expect(202);
  assert.equal(accepted.body.replayed, false);

  const beforePublish = await withSuperuserClient((client) => client.query(
    'SELECT published_at FROM alert_outbox WHERE alert_id = $1', [accepted.body.alertId]
  ));
  assert.equal(beforePublish.rows[0].published_at, null);

  const sent = [];
  let publisher;
  publisher = createOutboxPublisher({
    store: createOutboxStore({ db: createDb(intake.pool) }),
    logger: { error() {} },
    send: async (claim) => { sent.push(claim.payload); void publisher.stop(); },
  });
  publisher.start();
  await publisher.done;
  assert.deepEqual(sent, [{
    eventId: sent[0].eventId,
    alertId: accepted.body.alertId,
    tenantId: tenantA,
  }]);

  const published = await withSuperuserClient((client) => client.query(
    'SELECT id, published_at, claim_token, claimed_until FROM alert_outbox WHERE alert_id = $1',
    [accepted.body.alertId]
  ));
  assert.equal(published.rows[0].id, sent[0].eventId);
  assert.ok(published.rows[0].published_at);
  assert.equal(published.rows[0].claim_token, null);
  assert.equal(published.rows[0].claimed_until, null);

  const replay = await request(intake.app)
    .post('/api/v1/alerts')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(alertBody)
    .expect(202);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.alertId, accepted.body.alertId);

  let replayPublisher;
  replayPublisher = createOutboxPublisher({
    store: createOutboxStore({ db: createDb(intake.pool) }),
    logger: { error() {} },
    send: async (claim) => sent.push(claim.payload),
    sleep: async () => { void replayPublisher.stop(); },
  });
  replayPublisher.start();
  await replayPublisher.done;
  assert.equal(sent.length, 1);
  const counts = await withSuperuserClient((client) => client.query(
    `SELECT (SELECT count(*)::int FROM alerts WHERE id = $1) AS alerts,
            (SELECT count(*)::int FROM alert_outbox WHERE alert_id = $1) AS outbox`,
    [accepted.body.alertId]
  ));
  assert.deepEqual(counts.rows[0], { alerts: 1, outbox: 1 });
  await intake.pool.end();
});
