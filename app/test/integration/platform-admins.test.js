'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('platform_admins table holds no tenant data and carries no RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const id = await schema.getColumn(client, 'platform_admins', 'id');
    assert.equal(id.udt_name, 'uuid');
    assert.ok(await schema.hasPrimaryKey(client, 'platform_admins', ['id']));

    const email = await schema.getColumn(client, 'platform_admins', 'email');
    assert.equal(email.udt_name, 'text');
    assert.equal(email.is_nullable, 'NO');
    assert.ok(await schema.hasUniqueConstraint(client, 'platform_admins', ['email']));

    const passwordHash = await schema.getColumn(client, 'platform_admins', 'password_hash');
    assert.equal(passwordHash.udt_name, 'text');
    assert.equal(passwordHash.is_nullable, 'NO');

    // This table intentionally has no tenant_id column at all -- platform
    // admins are not tenant data and must never be scoped/bypassed by RLS.
    const tenantId = await schema.getColumn(client, 'platform_admins', 'tenant_id');
    assert.equal(tenantId, null);

    const rls = await schema.rlsStatus(client, 'platform_admins');
    assert.equal(rls.relrowsecurity, false);
    assert.equal(rls.relforcerowsecurity, false);
  });
});
