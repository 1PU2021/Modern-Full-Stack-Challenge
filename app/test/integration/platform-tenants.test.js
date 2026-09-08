'use strict';

const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/shared/config');
const { createDb, createPool } = require('../../src/shared/db');
const { createTenant, listTenants, setTenantActive } = require('../../src/intake/platform-tenants');
const { authenticateDemoUser } = require('../../src/intake/login');
const { ensureMigrated, withSuperuserClient } = require('./support/db');

let db;
let pool;

test('createTenant provisions the tenant and its initial tenant_admin atomically, in the same transaction', async (t) => {
  await ensureMigrated();
  pool = createPool(loadConfig().appDatabaseUrl);
  db = createDb(pool);
  t.after(async () => pool.end());

  const slug = `platform-test-${randomUUID().slice(0, 8)}`;
  const adminEmail = `admin@${slug}.test`;
  const result = await createTenant({
    db,
    input: {
      name: 'Platform Test Tenant', slug, tenantType: 'county_em',
      adminEmail, adminPassword: 'demo-only-change-me',
    },
  });

  t.after(async () => withSuperuserClient(async (client) => {
    await client.query('DELETE FROM users WHERE tenant_id = $1', [result.tenant.id]);
    await client.query('DELETE FROM tenants WHERE id = $1', [result.tenant.id]);
  }));

  assert.equal(result.tenant.slug, slug);
  assert.equal(result.tenant.tenantType, 'county_em');
  assert.equal(result.tenant.active, true);
  assert.equal(result.adminEmail, adminEmail);

  // The tenant_admin row really exists, is correctly tenant-scoped (not
  // bypassing RLS -- it was inserted via scopeToTenant() inside the SAME
  // transaction as the tenant insert), and the demo admin can immediately
  // log in with the password just set.
  const login = await authenticateDemoUser({
    db, jwtSecret: 'test-secret', email: adminEmail, password: 'demo-only-change-me',
  });
  assert.equal(login.role, 'tenant_admin');

  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      'SELECT tenant_id, role FROM users WHERE tenant_id = $1', [result.tenant.id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'tenant_admin');
  });
});

test('a slug conflict rejects the whole provisioning attempt and leaves no orphaned admin user behind', async (t) => {
  await ensureMigrated();
  pool = createPool(loadConfig().appDatabaseUrl);
  db = createDb(pool);
  t.after(async () => pool.end());

  // Self-contained: create our own tenant first rather than depending on
  // another test file having already seeded a well-known slug, since test
  // execution order and prior cleanup are not guaranteed across files.
  const takenSlug = `platform-conflict-${randomUUID().slice(0, 8)}`;
  const firstEmail = `admin@${takenSlug}.test`;
  const first = await createTenant({
    db,
    input: {
      name: 'First Tenant', slug: takenSlug, tenantType: 'county_em',
      adminEmail: firstEmail, adminPassword: 'demo-only-change-me',
    },
  });
  t.after(async () => withSuperuserClient(async (client) => {
    await client.query('DELETE FROM users WHERE tenant_id = $1', [first.tenant.id]);
    await client.query('DELETE FROM tenants WHERE id = $1', [first.tenant.id]);
  }));

  const orphanEmail = `admin-${randomUUID()}@conflict-test.test`;
  await assert.rejects(
    () => createTenant({
      db,
      input: {
        name: 'Conflict Test', slug: takenSlug, tenantType: 'county_em',
        adminEmail: orphanEmail, adminPassword: 'demo-only-change-me',
      },
    }),
    (error) => error.status === 409 && error.code === 'slug_taken'
  );

  // The tenant insert is what fails here (proving no partial state from
  // THIS attempt survives); the general "any failure anywhere in this
  // transaction rolls back everything, including an already-succeeded
  // tenant insert" guarantee is exercised directly, with a fake client
  // asserting ROLLBACK, in src/shared/db.test.js -- there is no legitimate
  // way to make the users insert fail on a brand-new tenant through this
  // public API alone (tenant_id+email is fresh by construction), so this
  // is the meaningful atomicity boundary to prove here.
  await withSuperuserClient(async (client) => {
    const { rows } = await client.query('SELECT 1 FROM users WHERE email = $1', [orphanEmail]);
    assert.equal(rows.length, 0);
  });
});

test('listTenants and setTenantActive round-trip through the real tenants table, and a disabled tenant cannot log in', async (t) => {
  await ensureMigrated();
  pool = createPool(loadConfig().appDatabaseUrl);
  db = createDb(pool);
  t.after(async () => pool.end());

  const slug = `platform-lifecycle-${randomUUID().slice(0, 8)}`;
  const adminEmail = `admin@${slug}.test`;
  const { tenant } = await createTenant({
    db,
    input: {
      name: 'Lifecycle Test Tenant', slug, tenantType: 'school_district',
      adminEmail, adminPassword: 'demo-only-change-me',
    },
  });
  t.after(async () => withSuperuserClient(async (client) => {
    await client.query('DELETE FROM users WHERE tenant_id = $1', [tenant.id]);
    await client.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
  }));

  const listed = await listTenants({ db });
  assert.ok(listed.some((row) => row.id === tenant.id && row.active === true));

  const disabled = await setTenantActive({ db, tenantId: tenant.id, active: false });
  assert.equal(disabled.active, false);

  await assert.rejects(
    () => authenticateDemoUser({
      db, jwtSecret: 'test-secret', email: adminEmail, password: 'demo-only-change-me',
    }),
    (error) => error.status === 401 && error.code === 'invalid_credentials'
  );

  await assert.rejects(
    () => setTenantActive({ db, tenantId: randomUUID(), active: true }),
    (error) => error.status === 404 && error.code === 'not_found'
  );
});
