'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('groups table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const tenantId = await schema.getColumn(client, 'groups', 'tenant_id');
    assert.equal(tenantId.is_nullable, 'NO');
    assert.ok(await schema.hasForeignKey(client, 'groups', 'tenant_id', 'tenants'));

    const name = await schema.getColumn(client, 'groups', 'name');
    assert.equal(name.is_nullable, 'NO');

    const rls = await schema.rlsStatus(client, 'groups');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'groups', 'tenant_isolation_groups'));
  });
});

test('group_members table matches spec section 4: composite PK, three FKs, RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    assert.ok(await schema.hasForeignKey(client, 'group_members', 'group_id', 'groups'));
    assert.ok(await schema.hasForeignKey(client, 'group_members', 'recipient_id', 'recipients'));
    assert.ok(await schema.hasForeignKey(client, 'group_members', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasPrimaryKey(client, 'group_members', ['group_id', 'recipient_id']));

    const rls = await schema.rlsStatus(client, 'group_members');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'group_members', 'tenant_isolation_group_members'));
  });
});
