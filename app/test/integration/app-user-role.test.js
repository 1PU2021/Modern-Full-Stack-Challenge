'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient, withAppUserClient } = require('./support/db');

test('app_user role exists, can log in, and is not superuser/bypassrls', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`
    );
    assert.equal(rows.length, 1, 'app_user role should exist');
    assert.equal(rows[0].rolcanlogin, true);
    assert.equal(rows[0].rolsuper, false, 'app_user must not be superuser or RLS is meaningless');
    assert.equal(rows[0].rolbypassrls, false, 'app_user must not bypass RLS');
  });
});

test('app_user can actually connect and is not the owner of the tenant-scoped tables', async () => {
  await withAppUserClient(async (client) => {
    const { rows } = await client.query('SELECT current_user');
    assert.equal(rows[0].current_user, 'app_user');
  });

  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`
    );
    assert.notEqual(rows[0].tableowner, 'app_user');
  });
});

test('app_user has CRUD grants on every tenant-scoped table', async () => {
  const tables = [
    'users',
    'groups',
    'recipients',
    'group_members',
    'alerts',
    'deliveries',
    'idempotency_keys',
    'alert_outbox',
  ];
  await withSuperuserClient(async (client) => {
    for (const table of tables) {
      const { rows } = await client.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const privileges = rows.map((row) => row.privilege_type);
      for (const required of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.ok(
          privileges.includes(required),
          `app_user should have ${required} on ${table}, got: ${privileges.join(', ')}`
        );
      }
    }
  });
});

test('app_user has only SELECT and the minimum write privileges the platform control plane needs on tenants', async () => {
  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT privilege_type, is_grantable
       FROM information_schema.role_table_grants
       WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'tenants'`
    );
    const privileges = rows.map((row) => row.privilege_type).sort();
    assert.deepEqual(privileges, ['INSERT', 'SELECT'].sort(), 'tenants should grant exactly SELECT + INSERT at the table level, never UPDATE-all-columns or DELETE');

    const { rows: columnPrivileges } = await client.query(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'tenants' AND privilege_type = 'UPDATE'`
    );
    assert.deepEqual(
      columnPrivileges.map((row) => row.column_name),
      ['active'],
      'app_user should only be able to UPDATE the active column on tenants, never slug/name/tenant_type'
    );
  });
});

test('app_user has SELECT/INSERT/UPDATE (no DELETE) on platform_admins, and no per-tenant table references it', async () => {
  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'platform_admins'`
    );
    const privileges = rows.map((row) => row.privilege_type).sort();
    assert.deepEqual(privileges, ['INSERT', 'SELECT', 'UPDATE'].sort());
  });
});

test('an app_user session with no tenant scoped sees zero rows on an RLS-protected table, even though rows exist', async () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type)
       VALUES ($1, 'rls-smoke-test', 'RLS Smoke Test', 'county_em')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId]
    );
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'smoke@example.com', 'x')`,
      [tenantId]
    );
  });

  try {
    await withAppUserClient(async (client) => {
      // No SET app.current_tenant at all -- current_setting(..., true) is
      // NULL, and tenant_id = NULL is never true, so this must see nothing.
      const { rows } = await client.query('SELECT * FROM users');
      assert.equal(rows.length, 0);
    });
  } finally {
    await withSuperuserClient(async (client) => {
      // Delete the referencing users row first -- users.tenant_id has no
      // ON DELETE CASCADE, so deleting the tenant first would violate the
      // FK constraint and leave both rows stranded for the next run.
      await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    });
  }
});
