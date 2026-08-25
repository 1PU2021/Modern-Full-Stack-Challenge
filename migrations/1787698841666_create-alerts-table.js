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
  pgm.createTable('alerts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    created_by: { type: 'uuid', notNull: true, references: 'users' },
    title: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    priority: {
      type: 'text',
      notNull: true,
      default: 'normal',
      check: "priority in ('low','normal','high','critical')",
    },
    channels: { type: 'text[]', notNull: true },
    target: { type: 'jsonb', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'accepted',
      check: "status in ('accepted','expanding','dispatching','completed','failed')",
    },
    idempotency_key: { type: 'text' },
    accepted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  }, {
    constraints: { unique: [['tenant_id', 'idempotency_key']] },
  });

  pgm.alterTable('alerts', { levelSecurity: 'ENABLE' });
  pgm.alterTable('alerts', { levelSecurity: 'FORCE' });
  pgm.createPolicy('alerts', 'tenant_isolation_alerts', {
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
  pgm.dropTable('alerts');
};
