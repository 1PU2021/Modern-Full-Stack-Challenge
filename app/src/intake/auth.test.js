'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createAuthMiddleware, requireRole } = require('./auth');

const SECRET = 'test-secret';
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

function token(payload = {}, options = {}) {
  return jwt.sign(
    { tenant_id: TENANT_ID, sub: USER_ID, role: 'operator', ...payload },
    SECRET,
    { algorithm: 'HS256', ...options }
  );
}

test('verified HS256 token exposes only normalized identity, including role', async () => {
  const signed = token({ ignored: 'value', role: 'tenant_admin' });
  const req = { headers: { authorization: `Bearer ${signed}` } };
  await invoke(createAuthMiddleware({ jwtSecret: SECRET }), req);
  assert.deepEqual(req.auth, { tenantId: TENANT_ID, userId: USER_ID, role: 'tenant_admin' });
});

test('missing or malformed bearer credentials require authentication', async () => {
  const middleware = createAuthMiddleware({ jwtSecret: SECRET });
  for (const authorization of [undefined, '', 'Basic abc', 'Bearer', `Bearer ${token()} extra`]) {
    const req = { headers: { authorization } };
    await assert.rejects(
      () => invoke(middleware, req),
      (error) => error.status === 401 && error.code === 'authentication_required'
    );
  }
});

test('bad signature, expiry, and non-HS256 algorithms are invalid tokens', async () => {
  const middleware = createAuthMiddleware({ jwtSecret: SECRET });
  const invalid = [
    jwt.sign({ tenant_id: TENANT_ID, sub: USER_ID }, 'wrong-secret', { algorithm: 'HS256' }),
    token({}, { expiresIn: -1 }),
    jwt.sign({ tenant_id: TENANT_ID, sub: USER_ID }, SECRET, { algorithm: 'HS384' }),
  ];
  for (const signed of invalid) {
    await assert.rejects(
      () => invoke(middleware, { headers: { authorization: `Bearer ${signed}` } }),
      (error) => error.status === 401 && error.code === 'invalid_token'
    );
  }
});

test('missing and malformed tenant_id or sub claims are invalid tokens', async () => {
  const middleware = createAuthMiddleware({ jwtSecret: SECRET });
  const invalid = [
    token({ tenant_id: undefined }),
    token({ sub: undefined }),
    token({ tenant_id: 'tenant-a' }),
    token({ sub: 'user-a' }),
  ];
  for (const signed of invalid) {
    await assert.rejects(
      () => invoke(middleware, { headers: { authorization: `Bearer ${signed}` } }),
      (error) => error.status === 401 && error.code === 'invalid_token'
    );
  }
});

test('missing or unknown role claims are invalid tokens', async () => {
  const middleware = createAuthMiddleware({ jwtSecret: SECRET });
  const invalid = [
    token({ role: undefined }),
    token({ role: 'platform_admin' }),
    token({ role: 'superuser' }),
  ];
  for (const signed of invalid) {
    await assert.rejects(
      () => invoke(middleware, { headers: { authorization: `Bearer ${signed}` } }),
      (error) => error.status === 401 && error.code === 'invalid_token'
    );
  }
});

test('a platform-scoped token (no tenant_id, scope: platform) is rejected by the tenant auth middleware', async () => {
  const middleware = createAuthMiddleware({ jwtSecret: SECRET });
  const platformToken = jwt.sign({ scope: 'platform', sub: USER_ID }, SECRET, { algorithm: 'HS256' });
  await assert.rejects(
    () => invoke(middleware, { headers: { authorization: `Bearer ${platformToken}` } }),
    (error) => error.status === 401 && error.code === 'invalid_token'
  );
});

test('requireRole allows a request whose auth.role is in the allowed set', async () => {
  const middleware = requireRole('tenant_admin', 'operator');
  const req = { auth: { role: 'operator' } };
  await invoke(middleware, req);
});

test('requireRole rejects a request whose auth.role is not in the allowed set, with 403 forbidden', async () => {
  const middleware = requireRole('tenant_admin');
  await assert.rejects(
    () => invoke(middleware, { auth: { role: 'operator' } }),
    (error) => error.status === 403 && error.code === 'forbidden'
  );
});

test('requireRole rejects a request with no auth at all', async () => {
  const middleware = requireRole('tenant_admin');
  await assert.rejects(
    () => invoke(middleware, {}),
    (error) => error.status === 403 && error.code === 'forbidden'
  );
});

test('authentication errors never expose the token', async () => {
  const signed = jwt.sign({ tenant_id: TENANT_ID, sub: USER_ID }, 'wrong-secret');
  await assert.rejects(
    () => invoke(createAuthMiddleware({ jwtSecret: SECRET }), {
      headers: { authorization: `Bearer ${signed}` },
    }),
    (error) => !error.message.includes(signed)
  );
});
