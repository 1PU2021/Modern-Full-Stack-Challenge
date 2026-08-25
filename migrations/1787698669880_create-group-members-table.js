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
  pgm.createTable('group_members', {
    group_id: { type: 'uuid', notNull: true, references: 'groups' },
    recipient_id: { type: 'uuid', notNull: true, references: 'recipients' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
  }, {
    constraints: { primaryKey: ['group_id', 'recipient_id'] },
  });

  pgm.alterTable('group_members', { levelSecurity: 'ENABLE' });
  pgm.alterTable('group_members', { levelSecurity: 'FORCE' });
  pgm.createPolicy('group_members', 'tenant_isolation_group_members', {
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
  pgm.dropTable('group_members');
};
