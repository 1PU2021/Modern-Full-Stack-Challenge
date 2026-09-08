'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { impersonateTenant } = require('./platform-tenants');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN_ID = '33333333-3333-3333-3333-333333333333';

function fixture({ tenant = { id: TENANT_ID, slug: 'demo-county', name: 'Demo County', active: true }, user = { id: USER_ID } } = {}) {
  const calls = [];
  return {
    calls,
    db: {
      pool: { async query(sql, params) { calls.push({ boundary: 'pool', sql, params }); return { rows: tenant ? [tenant] : [] }; } },
      async withTenant(tenantId, fn) {
        calls.push({ boundary: 'withTenant', tenantId });
        return fn({ query: async (sql, params) => { calls.push({ boundary: 'client', sql, params }); return { rows: user ? [user] : [] }; } });
      },
    },
  };
}

test('active tenant impersonation resolves a real tenant_admin under RLS and issues an ordinary tenant token', async () => {
  const { db, calls } = fixture();
  const signed = [];
  const result = await impersonateTenant({
    db, tenantId: TENANT_ID, platformAdminId: ADMIN_ID, jwtSecret: 'tenant-secret',
    issueToken: (input) => { signed.push(input); return 'impersonation-token'; },
  });

  assert.deepEqual(result, {
    token: 'impersonation-token', role: 'tenant_admin',
    tenant: { id: TENANT_ID, slug: 'demo-county', name: 'Demo County' },
  });
  assert.deepEqual(signed, [{
    tenantId: TENANT_ID, userId: USER_ID, role: 'tenant_admin', secret: 'tenant-secret', impersonatedBy: ADMIN_ID,
  }]);
  assert.equal(calls.find((call) => call.boundary === 'withTenant').tenantId, TENANT_ID);
  assert.match(calls.find((call) => call.boundary === 'client').sql, /role = 'tenant_admin'/);
});

test('inactive and nonexistent tenants are rejected before tenant-scoped user lookup', async () => {
  for (const [tenant, code] of [[null, 'not_found'], [{ id: TENANT_ID, active: false }, 'tenant_inactive']]) {
    const { db, calls } = fixture({ tenant });
    await assert.rejects(
      () => impersonateTenant({ db, tenantId: TENANT_ID, platformAdminId: ADMIN_ID, jwtSecret: 'secret' }),
      (error) => error.status === (code === 'not_found' ? 404 : 409) && error.code === code
    );
    assert.equal(calls.some((call) => call.boundary === 'withTenant'), false);
  }
});

test('an active tenant without a tenant_admin fails clearly and never falls back to an operator', async () => {
  const { db } = fixture({ user: null });
  await assert.rejects(
    () => impersonateTenant({ db, tenantId: TENANT_ID, platformAdminId: ADMIN_ID, jwtSecret: 'secret' }),
    (error) => error.status === 409 && error.code === 'tenant_admin_required'
  );
});
