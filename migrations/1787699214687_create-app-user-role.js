/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

const TENANT_SCOPED_TABLES = [
  'users',
  'groups',
  'recipients',
  'group_members',
  'alerts',
  'deliveries',
  'idempotency_keys',
];

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createRole('app_user', { login: true, password: 'app_user' });

  pgm.grantOnSchemas({ schemas: 'public', roles: 'app_user', privileges: 'USAGE' });

  pgm.grantOnTables({
    tables: 'tenants',
    roles: 'app_user',
    privileges: ['SELECT'],
  });

  pgm.grantOnTables({
    tables: TENANT_SCOPED_TABLES,
    roles: 'app_user',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.revokeOnTables({
    tables: TENANT_SCOPED_TABLES,
    roles: 'app_user',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  });
  pgm.revokeOnTables({ tables: 'tenants', roles: 'app_user', privileges: ['SELECT'] });
  pgm.revokeOnSchemas({ schemas: 'public', roles: 'app_user', privileges: 'USAGE' });
  pgm.dropRole('app_user');
};
