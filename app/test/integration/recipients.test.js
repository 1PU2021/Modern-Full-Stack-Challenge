'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('recipients table matches spec section 4, including the PostGIS location column, GIST index, and RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const id = await schema.getColumn(client, 'recipients', 'id');
    assert.equal(id.udt_name, 'uuid');

    const tenantId = await schema.getColumn(client, 'recipients', 'tenant_id');
    assert.equal(tenantId.is_nullable, 'NO');
    assert.ok(await schema.hasForeignKey(client, 'recipients', 'tenant_id', 'tenants'));

    const name = await schema.getColumn(client, 'recipients', 'name');
    assert.equal(name.is_nullable, 'NO');

    const phone = await schema.getColumn(client, 'recipients', 'phone');
    assert.equal(phone.is_nullable, 'YES');

    const email = await schema.getColumn(client, 'recipients', 'email');
    assert.equal(email.is_nullable, 'YES');

    const location = await schema.getColumn(client, 'recipients', 'location');
    assert.equal(location.udt_name, 'geography');
    assert.equal(location.is_nullable, 'YES');

    assert.ok(await schema.hasIndex(client, 'recipients', 'location', 'gist'));

    const deactivatedAt = await schema.getColumn(client, 'recipients', 'deactivated_at');
    assert.equal(deactivatedAt.udt_name, 'timestamptz');
    assert.equal(deactivatedAt.is_nullable, 'YES');

    for (const column of ['address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country']) {
      const addressColumn = await schema.getColumn(client, 'recipients', column);
      assert.equal(addressColumn.udt_name, 'text', `${column} should be text`);
      assert.equal(addressColumn.is_nullable, 'YES', `${column} should be nullable`);
    }

    const rls = await schema.rlsStatus(client, 'recipients');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'recipients', 'tenant_isolation_recipients'));
  });
});
