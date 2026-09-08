'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const schema = require('./support/schema');

test('deliveries table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    assert.ok(await schema.hasForeignKey(client, 'deliveries', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasForeignKey(client, 'deliveries', 'alert_id', 'alerts'));
    assert.ok(await schema.hasForeignKey(client, 'deliveries', 'recipient_id', 'recipients'));

    const channel = await schema.getColumn(client, 'deliveries', 'channel');
    assert.equal(channel.is_nullable, 'NO');
    assert.ok(await schema.checkConstraintContainsAll(client, 'deliveries', ["'sms'", "'email'"]));

    const status = await schema.getColumn(client, 'deliveries', 'status');
    assert.equal(status.is_nullable, 'NO');
    assert.equal(status.column_default, "'pending'::text");
    assert.ok(
      await schema.checkConstraintContainsAll(client, 'deliveries', [
        "'pending'",
        "'delivered'",
        "'failed'",
        "'rate_limited'",
        "'timed_out'",
      ])
    );

    const attemptCount = await schema.getColumn(client, 'deliveries', 'attempt_count');
    assert.equal(attemptCount.udt_name, 'int4');
    assert.equal(attemptCount.is_nullable, 'NO');
    assert.equal(attemptCount.column_default, '0');

    const providerResponse = await schema.getColumn(client, 'deliveries', 'provider_response');
    assert.equal(providerResponse.udt_name, 'jsonb');
    assert.equal(providerResponse.is_nullable, 'YES');

    const updatedAt = await schema.getColumn(client, 'deliveries', 'updated_at');
    assert.equal(updatedAt.is_nullable, 'NO');

    const deliveredAt = await schema.getColumn(client, 'deliveries', 'delivered_at');
    assert.equal(deliveredAt.is_nullable, 'YES');

    assert.ok(
      await schema.hasUniqueConstraint(client, 'deliveries', ['alert_id', 'recipient_id', 'channel'])
    );

    const rls = await schema.rlsStatus(client, 'deliveries');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'deliveries', 'tenant_isolation_deliveries'));
  });
});

test('idempotency_keys table matches spec section 4, including RLS', async () => {
  await ensureMigrated();
  await withSuperuserClient(async (client) => {
    assert.ok(await schema.hasForeignKey(client, 'idempotency_keys', 'tenant_id', 'tenants'));
    assert.ok(await schema.hasForeignKey(client, 'idempotency_keys', 'alert_id', 'alerts'));
    assert.ok(await schema.hasPrimaryKey(client, 'idempotency_keys', ['tenant_id', 'key']));

    // Spec section 4's RLS subsection was amended to add idempotency_keys to
    // the six originally-named tables -- it's tenant-scoped data that
    // participates directly in POST /alerts' idempotency lookup, and leaving
    // it unprotected would let exactly the bug class RLS exists to catch (a
    // query that forgets a tenant_id predicate) leak another tenant's
    // alert_id back to the caller.
    const rls = await schema.rlsStatus(client, 'idempotency_keys');
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    assert.ok(await schema.hasPolicy(client, 'idempotency_keys', 'tenant_isolation_idempotency_keys'));
  });
});
