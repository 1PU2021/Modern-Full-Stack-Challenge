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
  async function withTransaction(fn) {
    const client = await pool.connect();
    let releaseErr;
    try {
      await client.query('BEGIN');
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

  async function withTenant(tenantId, fn) {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error(`withTenant: "${tenantId}" is not a valid tenant id`);
    }
    return withTransaction(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
      return fn(client);
    });
  }

  // Escape hatch for platform-control-plane operations that create a NEW
  // tenant and must scope RLS to it mid-transaction -- the tenant's id
  // doesn't exist until the callback inserts it, so withTenant(existingId,
  // ...) can't be used. The callback must call scopeToTenant(tenantId)
  // before touching any RLS'd table (users, in practice, for the initial
  // tenant_admin row); everything happens in the SAME transaction as the
  // tenant insert, so a failure anywhere leaves neither row behind.
  async function withPlatformProvisioningTransaction(fn) {
    return withTransaction(async (client) => {
      async function scopeToTenant(tenantId) {
        if (!TENANT_ID_PATTERN.test(tenantId)) {
          throw new Error(`scopeToTenant: "${tenantId}" is not a valid tenant id`);
        }
        await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
      }
      return fn(client, scopeToTenant);
    });
  }

  // `pool` is an escape hatch for non-tenant-scoped operations (health
  // checks, tenants/platform_admins reads) plus the single pre-tenant login
  // bootstrap function. That SECURITY DEFINER function is execute-restricted
  // and returns only authentication fields; it is not a general users query.
  // All other tenant-owned access must use withTenant() or
  // withPlatformProvisioningTransaction() so SET LOCAL scopes forced RLS.
  return { pool, withTenant, withPlatformProvisioningTransaction };
}

module.exports = { createPool, createDb };
