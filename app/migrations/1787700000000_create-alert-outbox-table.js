'use strict';

exports.up = (pgm) => {
  pgm.createTable('alert_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    alert_id: { type: 'uuid', notNull: true, unique: true, references: 'alerts' },
    payload: { type: 'jsonb', notNull: true },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    published_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    claim_token: { type: 'uuid' },
    claimed_until: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('alert_outbox', ['tenant_id', 'available_at'], {
    name: 'alert_outbox_pending_idx',
    where: 'published_at IS NULL',
  });

  pgm.alterTable('alert_outbox', { levelSecurity: 'ENABLE' });
  pgm.alterTable('alert_outbox', { levelSecurity: 'FORCE' });
  pgm.createPolicy('alert_outbox', 'tenant_isolation_alert_outbox', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });

  pgm.grantOnTables({
    tables: 'alert_outbox',
    roles: 'app_user',
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('alert_outbox');
};
