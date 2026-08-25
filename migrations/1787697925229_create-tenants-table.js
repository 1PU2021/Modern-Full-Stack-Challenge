'use strict';

exports.up = (pgm) => {
  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    slug: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    tenant_type: {
      type: 'text',
      notNull: true,
      check:
        "tenant_type in ('state_agency','county_em','school_district','hospital_system','dispatch_center')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tenants');
};
