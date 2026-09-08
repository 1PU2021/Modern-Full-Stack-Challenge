'use strict';

exports.up = (pgm) => {
  pgm.createTable('idempotency_keys', {
    key: { type: 'text', notNull: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    alert_id: { type: 'uuid', notNull: true, references: 'alerts' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['tenant_id', 'key'] },
  });

  pgm.alterTable('idempotency_keys', { levelSecurity: 'ENABLE' });
  pgm.alterTable('idempotency_keys', { levelSecurity: 'FORCE' });
  pgm.createPolicy('idempotency_keys', 'tenant_isolation_idempotency_keys', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('idempotency_keys');
};
