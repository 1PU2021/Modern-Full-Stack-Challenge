'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { loadConfig } = require('../../src/shared/config');
const { createPool, createDb } = require('../../src/shared/db');
const { ensureMigrated, withSuperuserClient, appUserConnectionString } = require('./support/db');
const { createAuthHarness, signToken } = require('./support/auth-harness');

// Spec section 4, acceptance test #1 (app layer): authenticate as a user in
// tenant A, request GET /api/v1/alerts/:id for an alert that belongs to
// tenant B. Must be 404, not 403 -- tenant B's data shouldn't even register
// as "exists, but you can't see it."
//
// The harness's db pool must connect as app_user, not the postgres
// superuser that config.databaseUrl (.env's DATABASE_URL) points at.
// Postgres superusers have BYPASSRLS and skip RLS policies entirely
// regardless of app.current_tenant scoping, so a superuser-backed pool
// would make this test pass for the wrong reason -- it wouldn't be
// exercising RLS at all. app_user is the least-privileged role RLS is
// actually enforced against (see rls-database-layer.test.js).

test('GET /api/v1/alerts/:id returns 404, not 403, for an alert belonging to another tenant', async (t) => {
  await ensureMigrated();
  const config = loadConfig();
  const pool = createPool(appUserConnectionString(config.databaseUrl));
  const db = createDb(pool);
  t.after(() => pool.end());

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let tenantBAlertId;

  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant A', 'county_em')`,
      [tenantAId, `tenant-a-${tenantAId}`]
    );
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant B', 'school_district')`,
      [tenantBId, `tenant-b-${tenantBId}`]
    );
    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'operator@tenant-b.example', 'x') RETURNING id`,
      [tenantBId]
    );
    const { rows: alertRows } = await client.query(
      `INSERT INTO alerts (tenant_id, created_by, title, body, channels, target)
       VALUES ($1, $2, 'Test alert', 'body', ARRAY['sms'], '{"type":"group","groupId":"x"}'::jsonb)
       RETURNING id`,
      [tenantBId, userRows[0].id]
    );
    tenantBAlertId = alertRows[0].id;
  });

  t.after(async () => {
    await withSuperuserClient(async (client) => {
      // Delete children before parents -- alerts.created_by -> users and
      // users.tenant_id -> tenants both lack ON DELETE CASCADE.
      await client.query('DELETE FROM alerts WHERE tenant_id IN ($1, $2)', [tenantAId, tenantBId]);
      await client.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [tenantAId, tenantBId]);
      await client.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantAId, tenantBId]);
    });
  });

  const app = createAuthHarness({ jwtSecret: config.jwtSecret, db });
  const tenantAToken = signToken({ jwtSecret: config.jwtSecret, tenantId: tenantAId, userId: randomUUID() });

  const response = await request(app)
    .get(`/api/v1/alerts/${tenantBAlertId}`)
    .set('Authorization', `Bearer ${tenantAToken}`);

  assert.equal(response.status, 404);
  assert.notEqual(response.status, 403);
});

test('GET /api/v1/alerts/:id returns 200 when the alert belongs to the requesting tenant', async (t) => {
  await ensureMigrated();
  const config = loadConfig();
  const pool = createPool(appUserConnectionString(config.databaseUrl));
  const db = createDb(pool);
  t.after(() => pool.end());

  const tenantId = randomUUID();
  let alertId;

  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant', 'county_em')`,
      [tenantId, `tenant-${tenantId}`]
    );
    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'operator@tenant.example', 'x') RETURNING id`,
      [tenantId]
    );
    const { rows: alertRows } = await client.query(
      `INSERT INTO alerts (tenant_id, created_by, title, body, channels, target)
       VALUES ($1, $2, 'Own alert', 'body', ARRAY['email'], '{"type":"group","groupId":"x"}'::jsonb)
       RETURNING id`,
      [tenantId, userRows[0].id]
    );
    alertId = alertRows[0].id;
  });

  t.after(async () => {
    await withSuperuserClient(async (client) => {
      // Delete children before parents -- alerts.created_by -> users and
      // users.tenant_id -> tenants both lack ON DELETE CASCADE.
      await client.query('DELETE FROM alerts WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    });
  });

  const app = createAuthHarness({ jwtSecret: config.jwtSecret, db });
  const token = signToken({ jwtSecret: config.jwtSecret, tenantId, userId: randomUUID() });

  const response = await request(app)
    .get(`/api/v1/alerts/${alertId}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.id, alertId);
});
