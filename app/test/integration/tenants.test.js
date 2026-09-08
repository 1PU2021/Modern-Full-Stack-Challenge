'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('tenants table matches spec section 4', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const id = await schema.getColumn(client, 'tenants', 'id');
    assert.equal(id.udt_name, 'uuid');
    assert.equal(id.is_nullable, 'NO');
    assert.match(id.column_default, /gen_random_uuid/);
    assert.ok(await schema.hasPrimaryKey(client, 'tenants', ['id']));

    const slug = await schema.getColumn(client, 'tenants', 'slug');
    assert.equal(slug.udt_name, 'text');
    assert.equal(slug.is_nullable, 'NO');
    assert.ok(await schema.hasUniqueConstraint(client, 'tenants', ['slug']));

    const name = await schema.getColumn(client, 'tenants', 'name');
    assert.equal(name.udt_name, 'text');
    assert.equal(name.is_nullable, 'NO');

    const tenantType = await schema.getColumn(client, 'tenants', 'tenant_type');
    assert.equal(tenantType.udt_name, 'text');
    assert.equal(tenantType.is_nullable, 'NO');
    assert.ok(
      await schema.checkConstraintContainsAll(client, 'tenants', [
        "'state_agency'",
        "'county_em'",
        "'school_district'",
        "'hospital_system'",
        "'dispatch_center'",
      ])
    );

    const active = await schema.getColumn(client, 'tenants', 'active');
    assert.equal(active.udt_name, 'bool');
    assert.equal(active.is_nullable, 'NO');
    assert.equal(active.column_default, 'true');

    const createdAt = await schema.getColumn(client, 'tenants', 'created_at');
    assert.equal(createdAt.udt_name, 'timestamptz');
    assert.equal(createdAt.is_nullable, 'NO');
    assert.match(createdAt.column_default, /now\(\)/);

    // tenants is the isolation root -- it must NOT itself carry RLS.
    const rls = await schema.rlsStatus(client, 'tenants');
    assert.equal(rls.relrowsecurity, false);
  });
});
