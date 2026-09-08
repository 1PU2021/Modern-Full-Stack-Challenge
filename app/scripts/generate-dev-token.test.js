'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, createToken } = require('./generate-dev-token');

test('parseArgs supplies seeded demo defaults and accepts explicit values', () => {
  assert.deepEqual(parseArgs([]), { tenantSlug: 'demo-county', userEmail: 'admin@demo-county.test' });
  assert.deepEqual(parseArgs(['--tenant=demo-school', '--user=admin@demo-school.test']), { tenantSlug: 'demo-school', userEmail: 'admin@demo-school.test' });
});

test('parseArgs rejects unknown and malformed options', () => {
  assert.throws(() => parseArgs(['--secret=x']), /Unknown option/);
  assert.throws(() => parseArgs(['--tenant=']), /requires a value/);
});

test('createToken signs only normalized development identity claims with HS256', () => {
  const calls = [];
  const token = createToken({ tenantId: 'tenant-id', userId: 'user-id', secret: 'dev-secret', sign: (...args) => { calls.push(args); return 'token'; } });
  assert.equal(token, 'token');
  assert.deepEqual(calls[0], [{ tenant_id: 'tenant-id', sub: 'user-id' }, 'dev-secret', { algorithm: 'HS256', expiresIn: '8h' }]);
});
