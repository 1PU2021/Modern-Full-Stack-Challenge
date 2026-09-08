/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumn('tenants', {
    active: { type: 'boolean', notNull: true, default: true },
  });

  // `tenants` has no RLS (it isn't tenant-scoped data), so grants here are
  // the only access control available. Keep them to exactly what the
  // platform-control-plane endpoints need: INSERT a whole new tenant row,
  // and UPDATE only the `active` column (disable/enable) -- never slug,
  // name, or tenant_type, which are not mutable through any endpoint.
  pgm.grantOnTables({ tables: 'tenants', roles: 'app_user', privileges: ['INSERT'] });
  pgm.sql('GRANT UPDATE (active) ON tenants TO app_user');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.sql('REVOKE UPDATE (active) ON tenants FROM app_user');
  pgm.revokeOnTables({ tables: 'tenants', roles: 'app_user', privileges: ['INSERT'] });
  pgm.dropColumn('tenants', 'active');
};
