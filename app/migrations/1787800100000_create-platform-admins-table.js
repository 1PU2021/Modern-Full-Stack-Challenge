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
  // Deliberately NOT a tenant-scoped table: platform admins are the
  // control-plane's own identity, outside every tenant's RLS boundary. They
  // must never be modeled as rows in `users` (which is FORCE RLS'd per
  // tenant) or as a "special" tenant — see CLAUDE.md's tenant isolation
  // guarantees, which this table is designed to never need to bypass. No
  // RLS is applied here because this table holds no tenant data at all.
  pgm.createTable('platform_admins', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.grantOnTables({
    tables: 'platform_admins',
    roles: 'app_user',
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.revokeOnTables({
    tables: 'platform_admins',
    roles: 'app_user',
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
  });
  pgm.dropTable('platform_admins');
};
