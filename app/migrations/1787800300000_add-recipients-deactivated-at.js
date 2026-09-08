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
  // NULL = active (the default for every existing/newly-seeded recipient).
  // A soft-delete marker rather than a hard DELETE: recipients can already
  // be referenced by historical `deliveries` rows and `group_members`, and
  // there is no ON DELETE CASCADE on those references, so a hard delete
  // would either fail or require destructive cleanup of delivery history.
  // No grant change needed: `recipients` already has full DML granted to
  // app_user via TENANT_SCOPED_TABLES in create-app-user-role.
  pgm.addColumn('recipients', {
    deactivated_at: { type: 'timestamptz' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumn('recipients', 'deactivated_at');
};
