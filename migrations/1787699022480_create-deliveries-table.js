'use strict';

exports.up = (pgm) => {
  pgm.createTable('deliveries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    alert_id: { type: 'uuid', notNull: true, references: 'alerts' },
    recipient_id: { type: 'uuid', notNull: true, references: 'recipients' },
    channel: { type: 'text', notNull: true, check: "channel in ('sms','email')" },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status in ('pending','delivered','failed','rate_limited','timed_out')",
    },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    provider_response: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    delivered_at: { type: 'timestamptz' },
  }, {
    constraints: { unique: [['alert_id', 'recipient_id', 'channel']] },
  });

  pgm.alterTable('deliveries', { levelSecurity: 'ENABLE' });
  pgm.alterTable('deliveries', { levelSecurity: 'FORCE' });
  pgm.createPolicy('deliveries', 'tenant_isolation_deliveries', {
    using: "tenant_id = current_setting('app.current_tenant', true)::uuid",
    check: "tenant_id = current_setting('app.current_tenant', true)::uuid",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('deliveries');
};
