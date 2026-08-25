'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrated, migrateTo, withSuperuserClient } = require('./support/db');

test('the full migration chain can be reverted to zero and reapplied cleanly', async (t) => {
  await ensureMigrated();

  t.after(async () => {
    await ensureMigrated();
  });

  await migrateTo(-9); // revert all 9 migrations, oldest last
  await withSuperuserClient(async (client) => {
    // postgis, postgis_topology, and postgis_tiger_geocoder are pre-installed
    // in this database by the postgis/postgis Docker image itself (not
    // created by any of our migrations - the recipients migration's up()
    // uses createExtension with ifNotExists: true precisely because it may
    // already be present). Its down() correctly never drops the extension,
    // since postgis_topology/postgis_tiger_geocoder depend on it and this
    // migration never owned its lifecycle. spatial_ref_sys, geometry_columns,
    // and geography_columns are relations owned by that extension, so they
    // legitimately persist across a full revert; every other table must not.
    const postgisOwnedRelations = ['spatial_ref_sys', 'geometry_columns', 'geography_columns'];
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name != 'pgmigrations'`
    );
    const applicationTables = rows.filter((r) => !postgisOwnedRelations.includes(r.table_name));
    assert.deepEqual(
      applicationTables,
      [],
      'expected every application table to be gone after a full revert'
    );

    const { rows: roleRows } = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'app_user'`
    );
    assert.equal(roleRows.length, 0, 'app_user should not exist after a full revert');
  });

  await migrateTo(9);
  await withSuperuserClient(async (client) => {
    const postgisOwnedRelations = ['spatial_ref_sys', 'geometry_columns', 'geography_columns'];
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name != 'pgmigrations'
       ORDER BY table_name`
    );
    const applicationTables = rows
      .map((r) => r.table_name)
      .filter((name) => !postgisOwnedRelations.includes(name));
    assert.deepEqual(applicationTables, [
      'alerts',
      'deliveries',
      'group_members',
      'groups',
      'idempotency_keys',
      'recipients',
      'tenants',
      'users',
    ]);
  });
});
