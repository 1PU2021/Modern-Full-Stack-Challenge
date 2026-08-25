'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
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
    assert.ok(await schema.checkConstraintContainsAll(client, 'users', ["'operator'", "'admin'"]));

    assert.ok(await schema.hasUniqueConstraint(client, 'users', ['tenant_id', 'email']));

    const rls = await schema.rlsStatus(client, 'users');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);

    const policy = await schema.hasPolicy(client, 'users', 'tenant_isolation_users');
    assert.ok(policy);
    assert.match(policy.qual, /current_setting\('app\.current_tenant'::text, true\)\)::uuid/);
    assert.match(policy.with_check, /current_setting\('app\.current_tenant'::text, true\)\)::uuid/);
  });
});
