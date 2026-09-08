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
  // CREATE ROLE has no IF NOT EXISTS in Postgres, and roles are cluster-wide
  // (not per-database) -- guard creation so a second contributor's database
  // in the same local Postgres cluster doesn't fail migration with "role
  // already exists".
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user WITH LOGIN PASSWORD 'app_user';
      END IF;
    END
    $$;
  `);

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
  // Guard the drop too, for the same reason. This does NOT fully solve the
  // cross-database collision this role design has -- dropping app_user here
  // still affects any other database in this cluster that also uses it --
  // but it at least turns a hard failure into a safe no-op if the role was
  // already removed by something else.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        DROP ROLE app_user;
      END IF;
    END
    $$;
  `);
};
