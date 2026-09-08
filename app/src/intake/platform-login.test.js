'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { authenticatePlatformAdmin } = require('./platform-login');
const { hashDemoPassword } = require('../shared/demo-auth');

const ADMIN_ID = '33333333-3333-3333-3333-333333333333';

function fixture({ passwordHash = hashDemoPassword('correct-password', 'platform-login-test'), admin = true } = {}) {
  const calls = [];
  const db = {
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: admin ? [{ id: ADMIN_ID, password_hash: passwordHash }] : [] };
      },
    },
  };
  return { db, calls };
}

test('valid credentials look up platform_admins directly (no tenant scoping) and issue a platform token', async () => {
  const { db, calls } = fixture();
  const signCalls = [];
  const result = await authenticatePlatformAdmin({
    db, jwtSecret: 'platform-secret', email: 'platform-admin@critical-demo.test', password: 'correct-password',
    issueToken: (args) => { signCalls.push(args); return 'signed-platform-token'; },
  });
  assert.deepEqual(result, { token: 'signed-platform-token' });
  assert.deepEqual(calls, [{
    sql: calls[0].sql,
    params: ['platform-admin@critical-demo.test'],
  }]);
  assert.match(calls[0].sql, /platform_admins/);
  assert.deepEqual(signCalls, [{ adminId: ADMIN_ID, secret: 'platform-secret' }]);
});

test('unknown admin, wrong password, and malformed hashes are indistinguishable', async () => {
  const cases = [fixture({ admin: false }), fixture(), fixture({ passwordHash: 'malformed' })];
  const passwords = ['correct-password', 'wrong-password', 'correct-password'];
  for (let index = 0; index < cases.length; index += 1) {
    await assert.rejects(
      () => authenticatePlatformAdmin({ db: cases[index].db, jwtSecret: 'secret', email: 'x@y.test', password: passwords[index] }),
      (error) => error.status === 401 && error.code === 'invalid_credentials' && error.message === 'Invalid email or password'
    );
  }
});
