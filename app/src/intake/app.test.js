'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createMetrics } = require('../shared/metrics');
const { createApp, createReadiness } = require('./app');

const SECRET = 'app-test-secret';
const PLATFORM_SECRET = 'app-test-platform-secret';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN_ID = '33333333-3333-3333-3333-333333333333';

function fakeLogger() {
  const entries = [];
  function makeLogger(bindings = {}) {
    return {
      entries,
      child(fields) { return makeLogger({ ...bindings, ...fields }); },
      info(fields, message) { entries.push({ level: 'info', bindings, fields, message }); },
      error(fields, message) { entries.push({ level: 'error', bindings, fields, message }); },
    };
  }
  return makeLogger();
}

function routeFactories() {
  return {
    createLoginRouter() {
      const router = express.Router();
      router.post('/', (req, res) => res.json({ token: `token-for-${req.body.email}` }));
      return router;
    },
    createAlertsRouter() {
      const router = express.Router();
      router.get('/', (req, res) => res.json({ auth: req.auth }));
      return router;
    },
    createGroupsRouter() { return express.Router(); },
    createRecipientsRouter() { return express.Router(); },
    createUsersRouter() { return express.Router(); },
    createPlatformLoginRouter() {
      const router = express.Router();
      router.post('/', (req, res) => res.json({ token: `platform-token-for-${req.body.email}` }));
      return router;
    },
    createPlatformTenantsRouter() {
      const router = express.Router();
      router.get('/', (req, res) => res.json({ platformAuth: req.platformAuth }));
      return router;
    },
  };
}

function fixture({ queryError } = {}) {
  const pool = {
    queryCalls: 0,
    async query(text) {
      this.queryCalls += 1;
      assert.equal(text, 'SELECT 1');
      if (queryError) throw queryError;
      return { rows: [{ '?column?': 1 }] };
    },
  };
  const db = { pool };
  const metrics = createMetrics();
  const logger = fakeLogger();
  const readiness = createReadiness();
  const app = createApp({
    db,
    metrics,
    logger,
    jwtSecret: SECRET,
    platformJwtSecret: PLATFORM_SECRET,
    readiness,
    routeFactories: routeFactories(),
  });
  return { app, pool, metrics, logger, readiness };
}

test('healthz is public and never queries dependencies', async () => {
  const { app, pool } = fixture();
  const response = await request(app).get('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
  assert.equal(pool.queryCalls, 0);
});

test('readyz checks the pool until shutdown begins', async () => {
  const { app, readiness, pool } = fixture();
  assert.equal((await request(app).get('/readyz')).status, 200);
  readiness.beginShutdown();
  const response = await request(app).get('/readyz');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { status: 'not_ready' });
  assert.equal(pool.queryCalls, 1);
});

test('readyz returns 503 when the database is unreachable', async () => {
  const { app } = fixture({ queryError: new Error('offline') });
  const response = await request(app).get('/readyz');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { status: 'not_ready' });
});

test('metrics is public and uses the Prometheus content type', async () => {
  const { app } = fixture();
  const response = await request(app).get('/metrics');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/plain/);
  assert.match(response.text, /alert_intake_accepted_total/);
});

test('API routes require authentication and accept a valid token', async () => {
  const { app } = fixture();
  const missing = await request(app).get('/api/v1/alerts');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'authentication_required');

  const token = jwt.sign({ tenant_id: TENANT_ID, sub: USER_ID, role: 'operator' }, SECRET, { algorithm: 'HS256' });
  const valid = await request(app).get('/api/v1/alerts').set('Authorization', `Bearer ${token}`);
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.auth, { tenantId: TENANT_ID, userId: USER_ID, role: 'operator' });
});

test('demo login is public while protected routes remain authenticated', async () => {
  const { app } = fixture();
  const login = await request(app).post('/api/auth/login').send({ email: 'admin@demo-county.test' });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body, { token: 'token-for-admin@demo-county.test' });
  assert.equal((await request(app).get('/api/v1/alerts')).status, 401);
});

test('oversized JSON has a stable 413 response', async () => {
  const { app } = fixture();
  const response = await request(app)
    .post('/api/v1/alerts')
    .set('Content-Type', 'application/json')
    .send({ body: 'x'.repeat(257 * 1024) });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'payload_too_large');
});

test('request ids are echoed when valid and generated otherwise', async () => {
  const { app } = fixture();
  const supplied = await request(app).get('/healthz').set('X-Request-ID', 'request-123');
  assert.equal(supplied.headers['x-request-id'], 'request-123');

  const tooLong = await request(app).get('/healthz').set('X-Request-ID', 'x'.repeat(129));
  assert.match(tooLong.headers['x-request-id'], /^[0-9a-f-]{36}$/i);
  const missing = await request(app).get('/healthz');
  assert.match(missing.headers['x-request-id'], /^[0-9a-f-]{36}$/i);
});

test('completion logs contain request metadata but not headers or bodies', async () => {
  const { app, logger } = fixture();
  await request(app).get('/healthz').set('Authorization', 'Bearer secret-value');
  const entry = logger.entries.find(({ message }) => message === 'request completed');
  assert.ok(entry);
  assert.equal(entry.bindings.request_id.length > 0, true);
  assert.equal(entry.fields.method, 'GET');
  assert.equal(entry.fields.path, '/healthz');
  assert.equal(entry.fields.status, 200);
  assert.equal(typeof entry.fields.duration_ms, 'number');
  assert.doesNotMatch(JSON.stringify(entry), /secret-value|authorization|Take shelter/i);
});

test('platform login is public, platform routes require a platform token, and tenant tokens are rejected there', async () => {
  const { app } = fixture();
  const login = await request(app).post('/api/platform/auth/login').send({ email: 'platform-admin@critical-demo.test' });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body, { token: 'platform-token-for-platform-admin@critical-demo.test' });

  const missing = await request(app).get('/api/platform/tenants');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'authentication_required');

  const tenantToken = jwt.sign({ tenant_id: TENANT_ID, sub: USER_ID, role: 'tenant_admin' }, SECRET, { algorithm: 'HS256' });
  const rejectedTenantToken = await request(app).get('/api/platform/tenants').set('Authorization', `Bearer ${tenantToken}`);
  assert.equal(rejectedTenantToken.status, 401, 'a tenant token must never grant access to platform routes');

  const platformToken = jwt.sign({ scope: 'platform', sub: ADMIN_ID }, PLATFORM_SECRET, { algorithm: 'HS256' });
  const valid = await request(app).get('/api/platform/tenants').set('Authorization', `Bearer ${platformToken}`);
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.platformAuth, { adminId: ADMIN_ID });
});

test('a platform token is rejected by tenant-scoped /api/v1 routes', async () => {
  const { app } = fixture();
  const platformToken = jwt.sign({ scope: 'platform', sub: ADMIN_ID }, PLATFORM_SECRET, { algorithm: 'HS256' });
  const response = await request(app).get('/api/v1/alerts').set('Authorization', `Bearer ${platformToken}`);
  assert.equal(response.status, 401, 'a platform token must never grant access to tenant routes, even signed with the right secret for its own path');
});

test('unknown API routes return a structured JSON 404', async () => {
  const { app } = fixture();
  const token = jwt.sign({ tenant_id: TENANT_ID, sub: USER_ID, role: 'operator' }, SECRET, { algorithm: 'HS256' });
  const response = await request(app)
    .get('/api/v1/unknown')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'not_found');
});
