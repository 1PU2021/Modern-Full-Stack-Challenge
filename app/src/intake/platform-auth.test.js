'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createPlatformAuthMiddleware } = require('./platform-auth');

const PLATFORM_SECRET = 'platform-test-secret';
const TENANT_SECRET = 'tenant-test-secret';
const ADMIN_ID = '33333333-3333-3333-3333-333333333333';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function invoke(middleware, req) {
  return new Promise((resolve, reject) => {
    middleware(req, {}, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function platformToken(payload = {}, options = {}) {
  return jwt.sign(
    { scope: 'platform', sub: ADMIN_ID, ...payload },
    PLATFORM_SECRET,
    { algorithm: 'HS256', ...options }
  );
}

test('verified HS256 platform token exposes only the admin id', async () => {
  const signed = platformToken({ ignored: 'value' });
  const req = { headers: { authorization: `Bearer ${signed}` } };
  await invoke(createPlatformAuthMiddleware({ jwtSecret: PLATFORM_SECRET }), req);
  assert.deepEqual(req.platformAuth, { adminId: ADMIN_ID });
});

test('missing or malformed bearer credentials require authentication', async () => {
  const middleware = createPlatformAuthMiddleware({ jwtSecret: PLATFORM_SECRET });
  for (const authorization of [undefined, '', 'Basic abc', 'Bearer', `Bearer ${platformToken()} extra`]) {
    const req = { headers: { authorization } };
    await assert.rejects(
      () => invoke(middleware, req),
      (error) => error.status === 401 && error.code === 'authentication_required'
    );
  }
});

test('bad signature, expiry, and non-HS256 algorithms are invalid tokens', async () => {
  const middleware = createPlatformAuthMiddleware({ jwtSecret: PLATFORM_SECRET });
  const invalid = [
    jwt.sign({ scope: 'platform', sub: ADMIN_ID }, 'wrong-secret', { algorithm: 'HS256' }),
    platformToken({}, { expiresIn: -1 }),
    jwt.sign({ scope: 'platform', sub: ADMIN_ID }, PLATFORM_SECRET, { algorithm: 'HS384' }),
  ];
  for (const signed of invalid) {
    await assert.rejects(
      () => invoke(middleware, { headers: { authorization: `Bearer ${signed}` } }),
      (error) => error.status === 401 && error.code === 'invalid_token'
    );
  }
});

test('missing scope or sub claims are invalid tokens', async () => {
  const middleware = createPlatformAuthMiddleware({ jwtSecret: PLATFORM_SECRET });
  const invalid = [
    platformToken({ scope: undefined }),
    platformToken({ scope: 'tenant' }),
    platformToken({ sub: undefined }),
    platformToken({ sub: 'not-a-uuid' }),
  ];
  for (const signed of invalid) {
    await assert.rejects(
      () => invoke(middleware, { headers: { authorization: `Bearer ${signed}` } }),
      (error) => error.status === 401 && error.code === 'invalid_token'
    );
  }
});

test('a tenant-scoped token (tenant_id + role, no scope) is rejected by the platform auth middleware, even if it happens to share a secret', async () => {
  const middleware = createPlatformAuthMiddleware({ jwtSecret: TENANT_SECRET });
  const tenantToken = jwt.sign(
    { tenant_id: TENANT_ID, sub: USER_ID, role: 'tenant_admin' },
    TENANT_SECRET,
    { algorithm: 'HS256' }
  );
  await assert.rejects(
    () => invoke(middleware, { headers: { authorization: `Bearer ${tenantToken}` } }),
    (error) => error.status === 401 && error.code === 'invalid_token'
  );
});

test('a genuine platform token signed with the tenant JWT_SECRET is rejected -- the two secrets are not interchangeable', async () => {
  const middleware = createPlatformAuthMiddleware({ jwtSecret: PLATFORM_SECRET });
  const signedWithWrongSecret = jwt.sign({ scope: 'platform', sub: ADMIN_ID }, TENANT_SECRET, { algorithm: 'HS256' });
  await assert.rejects(
    () => invoke(middleware, { headers: { authorization: `Bearer ${signedWithWrongSecret}` } }),
    (error) => error.status === 401 && error.code === 'invalid_token'
  );
});

test('authentication errors never expose the token', async () => {
  const signed = jwt.sign({ scope: 'platform', sub: ADMIN_ID }, 'wrong-secret');
  await assert.rejects(
    () => invoke(createPlatformAuthMiddleware({ jwtSecret: PLATFORM_SECRET }), {
      headers: { authorization: `Bearer ${signed}` },
    }),
    (error) => !error.message.includes(signed)
  );
});
