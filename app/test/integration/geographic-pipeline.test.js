'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { after, before, test } = require('node:test');
const request = require('supertest');
const { loadConfig } = require('../../src/shared/config');
const { createDb, createPool } = require('../../src/shared/db');
const { createFanoutProcessor } = require('../../src/fanout/processor');
const { createFanoutStore } = require('../../src/fanout/store');
const { buildSeedPlan, seedDatabase } = require('../../scripts/seed');
const { createIntakeFixture } = require('./support/intake');
const { ensureMigrated, withSuperuserClient } = require('./support/db');

let intake;
let fanoutPool;
let plan;
let demoPolygon;

before(async () => {
  await ensureMigrated();
  const config = loadConfig();
  plan = buildSeedPlan({ demoUserPassword: config.demoUserPassword });
  await withSuperuserClient((client) => seedDatabase({ client, plan }));
  intake = createIntakeFixture();
  fanoutPool = createPool(config.appDatabaseUrl);
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../web/src/demo-geography.js'));
  ({ DEMO_POLYGON: demoPolygon } = await import(moduleUrl.href));
});

after(async () => {
  await intake?.pool.end();
  await fanoutPool?.end();
});

test('frontend demo polygon proceeds from login and intake outbox through tenant-scoped fanout deliveries', async () => {
  const login = await request(intake.app).post('/api/auth/login').send({
    email: 'admin@demo-county.test',
    password: loadConfig().demoUserPassword,
  });
  assert.equal(login.status, 200);
  assert.match(login.body.token, /^[^.]+\.[^.]+\.[^.]+$/);

  const accepted = await request(intake.app)
    .post('/api/v1/alerts')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({
      title: 'Geographic pipeline proof', body: 'Demo polygon', channels: ['sms'],
      target: { type: 'polygon', geojson: demoPolygon },
    });
  assert.equal(accepted.status, 202);

  const outbox = await withSuperuserClient((client) => client.query(
    'SELECT payload FROM alert_outbox WHERE alert_id = $1', [accepted.body.alertId]
  ));
  assert.equal(outbox.rows.length, 1);

  const sent = [];
  const acked = [];
  const store = createFanoutStore({ db: createDb(fanoutPool) });
  const processor = createFanoutProcessor({
    store,
    send: async (job) => sent.push(job),
    ack: async (message) => acked.push(message),
    logger: { child: () => ({ info() {}, error() {} }), error() {} },
  });
  const message = { Body: JSON.stringify(outbox.rows[0].payload), ReceiptHandle: 'pipeline-proof' };
  await processor.process(message);

  const byRole = Object.fromEntries(plan.recipients.filter((recipient) => recipient.geographicRole).map((recipient) => [recipient.geographicRole, recipient]));
  const selected = new Set(sent.map((job) => job.recipientId));
  assert.equal(acked.length, 1);
  assert.ok(sent.length > 0);
  assert.equal(selected.has(byRole['inside-a'].id), true);
  assert.equal(selected.has(byRole['inside-b'].id), true);
  assert.equal(selected.has(byRole.outside.id), false);
  assert.equal(selected.has(byRole.boundary.id), false);
  // Cross-tenant polygon exclusion (a demo-school recipient geographically
  // co-located with demo-county's search area) is covered independently by
  // fanout-store.test.js's 'polygon fanout uses strict containment, excludes
  // null and other tenants' test, using a synthetic fixture rather than
  // relocating a real demo-school recipient into demo-county's territory.
  assert.ok(sent.every((job) => job.tenantId === plan.tenants.find((tenant) => tenant.slug === 'demo-county').id));

  const rows = await withSuperuserClient((client) => client.query(
    'SELECT count(*)::int AS count FROM deliveries WHERE alert_id = $1', [accepted.body.alertId]
  ));
  assert.equal(rows.rows[0].count, sent.length);
});
