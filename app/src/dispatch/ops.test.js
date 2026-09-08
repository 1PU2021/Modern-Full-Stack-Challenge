'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createOpsApp, createReadiness } = require('./ops');

function app() {
  const readiness = createReadiness();
  const metrics = { register: { contentType: 'text/plain', metrics: async () => 'dispatch_metric 1\n' } };
  const db = { pool: { query: async () => ({ rows: [{ '?column?': 1 }] }) } };
  return { app: createOpsApp({ db, metrics, logger: { error() {} }, readiness }), readiness };
}

test('dispatch ops exposes health, readiness, and metrics', async () => {
  const fixture = app();
  assert.equal((await request(fixture.app).get('/healthz')).status, 200);
  assert.equal((await request(fixture.app).get('/readyz')).status, 200);
  assert.equal((await request(fixture.app).get('/metrics')).status, 200);
  fixture.readiness.beginShutdown();
  assert.equal((await request(fixture.app).get('/readyz')).status, 503);
});
