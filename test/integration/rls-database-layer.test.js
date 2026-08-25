'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { loadConfig } = require('../../src/shared/config');
const { ensureMigrated, withSuperuserClient, appUserConnectionString } = require('./support/db');

// Spec section 4, acceptance test #2 (database layer) -- the one the spec
// says "matters more," because it bypasses the app layer entirely. If this
// passes, RLS holds even for a query that forgets a WHERE tenant_id clause.

test('as app_user, scoping the session to tenant B and querying WHERE tenant_id = tenant A returns zero rows', async () => {
  await ensureMigrated();

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();

  await withSuperuserClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant A', 'county_em')`,
      [tenantAId, `tenant-a-${tenantAId}`]
    );
    await client.query(
      `INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1, $2, 'Tenant B', 'school_district')`,
      [tenantBId, `tenant-b-${tenantBId}`]
    );
    // A real row that genuinely belongs to tenant A -- if RLS is broken,
    // this is what a buggy "forgot WHERE tenant_id" query would leak.
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'operator@tenant-a.example', 'x')`,
      [tenantAId]
    );
  });

  try {
    const config = loadConfig();
    const appUserClient = new Client({ connectionString: appUserConnectionString(config.databaseUrl) });
    await appUserClient.connect();
    try {
      await appUserClient.query('BEGIN');
      // Scope this session to tenant B.
      await appUserClient.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant',
        tenantBId,
      ]);
      // Query directly for tenant A's rows -- exactly what a bug that
      // forgot a WHERE tenant_id clause, or supplied the wrong one, would do.
      const result = await appUserClient.query('SELECT * FROM users WHERE tenant_id = $1', [
        tenantAId,
      ]);
      assert.equal(result.rows.length, 0, 'RLS must return zero rows for another tenant, even asked for explicitly');
      await appUserClient.query('COMMIT');
    } finally {
      await appUserClient.end();
    }
  } finally {
    await withSuperuserClient(async (client) => {
      // users.tenant_id has no ON DELETE CASCADE (a deliberate schema
      // choice, not an oversight) -- delete the dependent row before its
      // parent tenant, or this delete fails on the FK constraint.
      await client.query('DELETE FROM users WHERE tenant_id IN ($1, $2)', [tenantAId, tenantBId]);
      await client.query('DELETE FROM tenants WHERE id IN ($1, $2)', [tenantAId, tenantBId]);
    });
  }
});
