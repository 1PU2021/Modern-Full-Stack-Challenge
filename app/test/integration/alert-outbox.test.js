'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('alert_outbox matches the intake design, including RLS and pending index', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    const expected = {
      id: ['uuid', 'NO'],
      tenant_id: ['uuid', 'NO'],
      alert_id: ['uuid', 'NO'],
      payload: ['jsonb', 'NO'],
      attempt_count: ['int4', 'NO'],
      available_at: ['timestamptz', 'NO'],
      published_at: ['timestamptz', 'YES'],
      last_error: ['text', 'YES'],
      claim_token: ['uuid', 'YES'],
      claimed_until: ['timestamptz', 'YES'],
      created_at: ['timestamptz', 'NO'],
    };

    for (const [name, [type, nullable]] of Object.entries(expected)) {
      const column = await schema.getColumn(client, 'alert_outbox', name);
      assert.ok(column, `expected alert_outbox.${name} to exist`);
      assert.equal(column.udt_name, type, name);
      assert.equal(column.is_nullable, nullable, name);
    }

    assert.ok(await schema.hasPrimaryKey(client, 'alert_outbox', ['id']));
    assert.ok(await schema.hasForeignKey(client, 'alert_outbox', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasForeignKey(client, 'alert_outbox', 'alert_id', 'alerts'));
    assert.ok(await schema.hasUniqueConstraint(client, 'alert_outbox', ['alert_id']));

    const rls = await schema.rlsStatus(client, 'alert_outbox');
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
    assert.ok(await schema.hasPolicy(client, 'alert_outbox', 'tenant_isolation_alert_outbox'));

    const { rows } = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'alert_outbox'`
    );
    assert.ok(
      rows.some(
        ({ indexdef }) =>
          indexdef.includes('(tenant_id, available_at)') &&
          indexdef.includes('published_at IS NULL')
      ),
      'expected a partial pending-work index on tenant_id and available_at'
    );
  });
});
