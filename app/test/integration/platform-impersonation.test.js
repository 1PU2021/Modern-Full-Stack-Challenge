'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { after, before, test } = require('node:test');
const { loadConfig } = require('../../src/shared/config');
const { createTenant, setTenantActive } = require('../../src/intake/platform-tenants');
const { createDb } = require('../../src/shared/db');
const { createIntakeFixture } = require('./support/intake');
const { ensureMigrated, withSuperuserClient } = require('./support/db');

let fixture;
let db;
let platformAdminId;
let tenant;
let tenantAdminId;
let otherTenant;
let otherTenantAdminId;

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture();
  db = createDb(fixture.pool);
  platformAdminId = randomUUID();
  await withSuperuserClient((client) => client.query(
    `INSERT INTO platform_admins (id, email, password_hash)
     VALUES ($1, $2, 'test-only')`,
    [platformAdminId, `impersonation-${platformAdminId}@example.test`]
  ));
  ({ tenant } = await createTenant({
    db,
    input: {
      name: 'Impersonation Tenant', slug: `impersonation-${randomUUID().slice(0, 8)}`,
      tenantType: 'county_em', adminEmail: `admin-${randomUUID()}@example.test`,
      adminPassword: 'demo-only-change-me',
    },
  }));
  ({ tenant: otherTenant } = await createTenant({
    db,
    input: {
      name: 'Other Tenant', slug: `other-${randomUUID().slice(0, 8)}`,
      tenantType: 'school_district', adminEmail: `admin-${randomUUID()}@example.test`,
      adminPassword: 'demo-only-change-me',
    },
  }));
  tenantAdminId = await db.withTenant(tenant.id, async (client) => {
    const { rows } = await client.query("SELECT id FROM users WHERE tenant_id = $1 AND role = 'tenant_admin'", [tenant.id]);
    return rows[0].id;
  });
  otherTenantAdminId = await db.withTenant(otherTenant.id, async (client) => {
    const { rows } = await client.query("SELECT id FROM users WHERE tenant_id = $1 AND role = 'tenant_admin'", [otherTenant.id]);
    return rows[0].id;
  });
});

after(async () => {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [tenant.id, otherTenant.id]);
    await client.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenant.id, otherTenant.id]);
    await client.query('DELETE FROM platform_admins WHERE id = $1', [platformAdminId]);
  });
  await fixture?.pool.end();
});

test('platform admin impersonates an active tenant and the token uses normal tenant auth and RLS', async () => {
  const response = await request(fixture.app)
    .post(`/api/platform/tenants/${tenant.id}/impersonate`)
    .set('Authorization', `Bearer ${fixture.signPlatform({ adminId: platformAdminId })}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.role, 'tenant_admin');
  assert.equal(response.body.tenant.id, tenant.id);

  const claims = jwt.verify(response.body.token, loadConfig().jwtSecret, { algorithms: ['HS256'] });
  assert.equal(claims.tenant_id, tenant.id);
  assert.equal(claims.sub, tenantAdminId);
  assert.equal(claims.role, 'tenant_admin');
  assert.equal(claims.impersonation, true);
  assert.equal(claims.impersonated_by, platformAdminId);

  const users = await request(fixture.app)
    .get('/api/v1/users')
    .set('Authorization', `Bearer ${response.body.token}`);
  assert.equal(users.status, 200);
  assert.ok(users.body.some((user) => user.id === tenantAdminId));
  assert.ok(users.body.every((user) => user.id !== otherTenantAdminId));
});

test('tenant tokens cannot initiate impersonation regardless of tenant role', async () => {
  for (const role of ['tenant_admin', 'operator']) {
    const response = await request(fixture.app)
      .post(`/api/platform/tenants/${tenant.id}/impersonate`)
      .set('Authorization', `Bearer ${fixture.sign({ tenantId: tenant.id, userId: tenantAdminId, role })}`);
    assert.equal(response.status, 401);
  }
});

test('inactive and nonexistent tenants cannot be impersonated', async () => {
  const platformToken = fixture.signPlatform({ adminId: platformAdminId });
  await setTenantActive({ db, tenantId: tenant.id, active: false });
  const inactive = await request(fixture.app)
    .post(`/api/platform/tenants/${tenant.id}/impersonate`)
    .set('Authorization', `Bearer ${platformToken}`);
  assert.equal(inactive.status, 409);
  assert.equal(inactive.body.error.code, 'tenant_inactive');
  await setTenantActive({ db, tenantId: tenant.id, active: true });

  const missing = await request(fixture.app)
    .post(`/api/platform/tenants/${randomUUID()}/impersonate`)
    .set('Authorization', `Bearer ${platformToken}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});
