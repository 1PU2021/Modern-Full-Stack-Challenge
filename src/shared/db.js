'use strict';

const { Pool } = require('pg');

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createPool(databaseUrl) {
  return new Pool({ connectionString: databaseUrl });
}

function createDb(pool) {
  async function withTenant(tenantId, fn) {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error(`withTenant: "${tenantId}" is not a valid tenant id`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { pool, withTenant };
}

module.exports = { createPool, createDb };
