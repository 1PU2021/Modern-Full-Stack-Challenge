'use strict';

const { Pool } = require('pg');

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Callers choose which connection string to pass. Tenant-scoped services
// must pass config.appDatabaseUrl (the app_user role) -- passing
// config.databaseUrl (the migration-owner/superuser role) here silently
// bypasses every RLS policy in this schema. See docs/APP_SPEC.md section 4.
function createPool(databaseUrl) {
  return new Pool({ connectionString: databaseUrl });
}

function createDb(pool) {
  async function withTenant(tenantId, fn) {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error(`withTenant: "${tenantId}" is not a valid tenant id`);
    }

    const client = await pool.connect();
    let releaseErr;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        releaseErr = rollbackErr;
      }
      throw err;
    } finally {
      client.release(releaseErr);
    }
  }

  // `pool` is an escape hatch for non-tenant-scoped operations only (health
  // checks, migrations-adjacent tooling). Tenant-scoped data access must go
  // through withTenant() exclusively — querying `pool` directly bypasses the
  // SET LOCAL app.current_tenant scoping that RLS depends on.
  return { pool, withTenant };
}

module.exports = { createPool, createDb };
