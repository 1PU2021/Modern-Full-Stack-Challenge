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
  // Deliberately no RLS -- spec section 4's RLS table list names six tables
  // and idempotency_keys is not one of them.
};

exports.down = (pgm) => {
  pgm.dropTable('idempotency_keys');
};
