'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hashDemoPassword, issueJwt, issuePlatformJwt, verifyDemoPassword } = require('./demo-auth');

test('demo passwords use deterministic versioned scrypt hashes', () => {
  const encoded = hashDemoPassword('demo-password', 'stable-salt');
  assert.match(encoded, /^scrypt\$stable-salt\$[0-9a-f]{128}$/);
  assert.equal(encoded, hashDemoPassword('demo-password', 'stable-salt'));
});

test('demo password verification is timing-safe for valid, invalid, and malformed hashes', () => {
  const encoded = hashDemoPassword('demo-password', 'stable-salt');
  assert.equal(verifyDemoPassword('demo-password', encoded), true);
  assert.equal(verifyDemoPassword('wrong-password', encoded), false);
  assert.equal(verifyDemoPassword('demo-password', 'not-a-hash'), false);
});

test('JWT issuance preserves the existing HS256 tenant identity contract and carries the role claim', () => {
  const calls = [];
  const token = issueJwt({
    tenantId: 'tenant-id', userId: 'user-id', role: 'tenant_admin', secret: 'secret',
    sign: (...args) => { calls.push(args); return 'token'; },
  });
  assert.equal(token, 'token');
  assert.deepEqual(calls, [[
    { tenant_id: 'tenant-id', sub: 'user-id', role: 'tenant_admin' },
    'secret',
    { algorithm: 'HS256', expiresIn: '8h' },
  ]]);
});

test('tenant JWT issuance carries explicit impersonation metadata when requested', () => {
  const calls = [];
  issueJwt({
    tenantId: 'tenant-id', userId: 'user-id', role: 'tenant_admin', secret: 'secret',
    impersonatedBy: 'platform-admin-id',
    sign: (...args) => { calls.push(args); return 'token'; },
  });
  assert.deepEqual(calls[0][0], {
    tenant_id: 'tenant-id', sub: 'user-id', role: 'tenant_admin',
    impersonation: true, impersonated_by: 'platform-admin-id',
  });
});

test('platform JWT issuance uses a distinct claim shape (no tenant_id) from tenant tokens', () => {
  const calls = [];
  const token = issuePlatformJwt({
    adminId: 'admin-id', secret: 'platform-secret',
    sign: (...args) => { calls.push(args); return 'platform-token'; },
  });
  assert.equal(token, 'platform-token');
  assert.deepEqual(calls, [[
    { scope: 'platform', sub: 'admin-id' },
    'platform-secret',
    { algorithm: 'HS256', expiresIn: '8h' },
  ]]);
});
