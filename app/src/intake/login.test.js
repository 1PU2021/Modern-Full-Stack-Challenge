'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { authenticateDemoUser, parseLoginRequest } = require('./login');
const { hashDemoPassword } = require('../shared/demo-auth');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function fixture({
  passwordHash = hashDemoPassword('correct-password', 'login-test'),
  tenantActive = true, user = true, role = 'operator',
} = {}) {
  const calls = [];
  const db = {
    pool: { query: async (sql, params) => {
      calls.push({ scope: 'login-discovery', sql, params });
      return { rows: user ? [{
        user_id: USER_ID, tenant_id: TENANT_ID, password_hash: passwordHash, role,
        tenant_active: tenantActive, tenant_slug: 'demo-county', tenant_name: 'Demo County',
      }] : [] };
    } },
  };
  return { db, calls };
}

test('email-only discovery derives tenant identity and issues the existing JWT claims', async () => {
  const { db, calls } = fixture({ role: 'tenant_admin' });
  const signCalls = [];
  const result = await authenticateDemoUser({
    db, jwtSecret: 'secret', email: 'admin@demo-county.test', password: 'correct-password',
    issueToken: (args) => { signCalls.push(args); return 'signed-token'; },
  });
  assert.deepEqual(result, {
    token: 'signed-token', role: 'tenant_admin',
    tenant: { id: TENANT_ID, slug: 'demo-county', name: 'Demo County' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'login-discovery');
  assert.match(calls[0].sql, /find_tenant_user_for_login/);
  assert.deepEqual(calls[0].params, ['admin@demo-county.test']);
  assert.deepEqual(signCalls, [{ tenantId: TENANT_ID, userId: USER_ID, role: 'tenant_admin', secret: 'secret' }]);
});

test('unknown email, disabled tenant, wrong password, and malformed hashes are indistinguishable', async () => {
  const cases = [
    fixture({ user: false }), fixture({ tenantActive: false }), fixture(), fixture({ passwordHash: 'malformed' }),
  ];
  const passwords = ['correct-password', 'correct-password', 'wrong-password', 'correct-password'];
  for (let index = 0; index < cases.length; index += 1) {
    await assert.rejects(
      () => authenticateDemoUser({ db: cases[index].db, jwtSecret: 'secret', email: 'x@y.test', password: passwords[index] }),
      (error) => error.status === 401 && error.code === 'invalid_credentials' && error.message === 'Invalid email or password'
    );
  }
});

test('login request accepts only email and password and rejects the removed tenant slug field', () => {
  assert.deepEqual(parseLoginRequest({
    email: 'admin@demo-county.test', password: 'correct-password',
  }), { email: 'admin@demo-county.test', password: 'correct-password' });

  assert.throws(
    () => parseLoginRequest({
      tenantSlug: 'demo-county', email: 'admin@demo-county.test', password: 'correct-password',
    }),
    (error) => error.status === 400 && error.code === 'validation_failed'
  );
});
