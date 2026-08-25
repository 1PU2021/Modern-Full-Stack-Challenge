'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('alerts table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    assert.ok(await schema.hasForeignKey(client, 'alerts', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasForeignKey(client, 'alerts', 'created_by', 'users'));

    const title = await schema.getColumn(client, 'alerts', 'title');
    assert.equal(title.is_nullable, 'NO');

    const body = await schema.getColumn(client, 'alerts', 'body');
    assert.equal(body.is_nullable, 'NO');

    const priority = await schema.getColumn(client, 'alerts', 'priority');
    assert.equal(priority.is_nullable, 'NO');
    assert.equal(priority.column_default, "'normal'::text");
    assert.ok(
      await schema.checkConstraintContainsAll(client, 'alerts', [
        "'low'",
        "'normal'",
        "'high'",
        "'critical'",
      ])
    );

    const channels = await schema.getColumn(client, 'alerts', 'channels');
    assert.equal(channels.udt_name, '_text');
    assert.equal(channels.is_nullable, 'NO');

    const target = await schema.getColumn(client, 'alerts', 'target');
    assert.equal(target.udt_name, 'jsonb');
    assert.equal(target.is_nullable, 'NO');

    const status = await schema.getColumn(client, 'alerts', 'status');
    assert.equal(status.is_nullable, 'NO');
    assert.equal(status.column_default, "'accepted'::text");
    assert.ok(
      await schema.checkConstraintContainsAll(client, 'alerts', [
        "'accepted'",
        "'expanding'",
        "'dispatching'",
        "'completed'",
        "'failed'",
      ])
    );

    const idempotencyKey = await schema.getColumn(client, 'alerts', 'idempotency_key');
    assert.equal(idempotencyKey.is_nullable, 'YES');

    const acceptedAt = await schema.getColumn(client, 'alerts', 'accepted_at');
    assert.equal(acceptedAt.is_nullable, 'NO');

    const completedAt = await schema.getColumn(client, 'alerts', 'completed_at');
    assert.equal(completedAt.is_nullable, 'YES');

    assert.ok(await schema.hasUniqueConstraint(client, 'alerts', ['tenant_id', 'idempotency_key']));

    const rls = await schema.rlsStatus(client, 'alerts');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'alerts', 'tenant_isolation_alerts'));
  });
});
