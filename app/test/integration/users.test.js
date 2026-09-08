'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withAppUserClient, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('users table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const id = await schema.getColumn(client, 'users', 'id');
    assert.equal(id.udt_name, 'uuid');
    assert.ok(await schema.hasPrimaryKey(client, 'users', ['id']));

    const tenantId = await schema.getColumn(client, 'users', 'tenant_id');
    assert.equal(tenantId.udt_name, 'uuid');
    assert.equal(tenantId.is_nullable, 'NO');
    assert.ok(await schema.hasForeignKey(client, 'users', 'tenant_id', 'tenants'));

    const email = await schema.getColumn(client, 'users', 'email');
    assert.equal(email.udt_name, 'text');
    assert.equal(email.is_nullable, 'NO');

    const passwordHash = await schema.getColumn(client, 'users', 'password_hash');
    assert.equal(passwordHash.udt_name, 'text');
    assert.equal(passwordHash.is_nullable, 'NO');

    const role = await schema.getColumn(client, 'users', 'role');
    assert.equal(role.is_nullable, 'NO');
    assert.equal(role.column_default, "'operator'::text");
    assert.ok(await schema.checkConstraintContainsAll(client, 'users', ["'operator'", "'tenant_admin'"]));

    assert.equal(await schema.hasUniqueConstraint(client, 'users', ['tenant_id', 'email']), false);
    const { rows: indexes } = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'users' AND indexname = 'users_email_lower_unique'`
    );
    assert.equal(indexes.length, 1);
    assert.match(indexes[0].indexdef, /UNIQUE INDEX .*lower\(email\)/i);

    const rls = await schema.rlsStatus(client, 'users');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);

    const policy = await schema.hasPolicy(client, 'users', 'tenant_isolation_users');
    assert.ok(policy);
    assert.match(policy.qual, /current_setting\('app\.current_tenant'::text, true\)\)::uuid/);
    assert.match(policy.with_check, /current_setting\('app\.current_tenant'::text, true\)\)::uuid/);
  });
});

test('user email is globally unique across tenants, including case variants', async (t) => {
  await ensureMigrated();
  const firstTenant = '71111111-1111-4111-8111-111111111111';
  const secondTenant = '72222222-2222-4222-8222-222222222222';
  t.after(() => withSuperuserClient(async (client) => {
    await client.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [firstTenant, secondTenant]);
    await client.query('DELETE FROM tenants WHERE id IN ($1, $2)', [firstTenant, secondTenant]);
  }));
  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES
       ($1, 'global-email-a', 'Global Email A', 'county_em'),
       ($2, 'global-email-b', 'Global Email B', 'county_em')`,
      [firstTenant, secondTenant]
    );
    await client.query(
      "INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'Unique.User@example.test', 'x')",
      [firstTenant]
    );
    await assert.rejects(
      () => client.query(
        "INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'unique.user@EXAMPLE.test', 'x')",
        [secondTenant]
      ),
      (error) => error.code === '23505'
    );
  });
});

test('app_user can discover only the minimum login fields without gaining unscoped users access', async (t) => {
  await ensureMigrated();
  const tenantId = '73333333-3333-4333-8333-333333333333';
  const userId = '74444444-4444-4444-8444-444444444444';
  t.after(() => withSuperuserClient(async (client) => {
    await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  }));
  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type, active)
       VALUES ($1, 'login-discovery', 'Login Discovery Tenant', 'county_em', true)`,
      [tenantId]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, 'Discover.Me@example.test', 'hash-value', 'tenant_admin')`,
      [userId, tenantId]
    );
  });

  await withAppUserClient(async (client) => {
    const hidden = await client.query('SELECT id FROM users');
    assert.equal(hidden.rows.length, 0, 'ordinary unscoped users reads must remain blocked by RLS');
    const found = await client.query(
      'SELECT * FROM public.find_tenant_user_for_login($1)',
      ['discover.me@EXAMPLE.test']
    );
    assert.deepEqual(found.rows, [{
      user_id: userId,
      tenant_id: tenantId,
      role: 'tenant_admin',
      password_hash: 'hash-value',
      tenant_active: true,
      tenant_slug: 'login-discovery',
      tenant_name: 'Login Discovery Tenant',
    }]);
  });

  await withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT prosecdef, proconfig, proacl
       FROM pg_proc WHERE oid = 'public.find_tenant_user_for_login(text)'::regprocedure`
    );
    assert.equal(rows[0].prosecdef, true);
    assert.ok(rows[0].proconfig.includes('search_path=pg_catalog, public'));
    assert.match(rows[0].proacl, /(?:^\{|,)app_user=X\//);
    assert.doesNotMatch(rows[0].proacl, /(?:^\{|,)=X\//, 'PUBLIC must not execute login discovery');
  });
});
