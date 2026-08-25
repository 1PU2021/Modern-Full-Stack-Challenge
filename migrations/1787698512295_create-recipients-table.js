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
  pgm.createExtension('postgis', { ifNotExists: true });

  pgm.createTable('recipients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    email: { type: 'text' },
    location: { type: 'geography(Point,4326)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('recipients', 'location', { method: 'gist' });

  pgm.alterTable('recipients', { levelSecurity: 'ENABLE' });
  pgm.alterTable('recipients', { levelSecurity: 'FORCE' });
  pgm.createPolicy('recipients', 'tenant_isolation_recipients', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('recipients');
  // Deliberately not dropping the postgis extension: up() creates it with
  // ifNotExists: true because it may already be provided by the database
  // environment (e.g. the postgis/postgis Docker image pre-installs it,
  // along with postgis_topology and postgis_tiger_geocoder, which depend
  // on it). This migration never assumed ownership of that extension, so
  // down() must not attempt to remove it — doing so fails outright when
  // those dependent extensions are present, and forcing it with CASCADE
  // would destroy shared infrastructure this migration never created.
};
