'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const request = require('supertest');
const { createOpsApp, createReadiness } = require('./ops');

function fixture() {
  const readiness = createReadiness();
  const errors = [];
  const metrics = {
    register: { contentType: 'text/plain; version=0.0.4', metrics: async () => '# HELP fanout 1\n' },
  };
  const app = createOpsApp({
    db: { pool: { query: async () => ({ rows: [{ '?column?': 1 }] }) } },
    metrics,
    logger: { error(...args) { errors.push(args); }, info() {} },
    readiness,
  });
  return { app, readiness, errors };
}

test('healthz is public and readiness becomes 503 during shutdown', async () => {
  const value = fixture();
  await request(value.app).get('/healthz').expect(200, { status: 'ok' });
  await request(value.app).get('/readyz').expect(200, { status: 'ready' });
  value.readiness.beginShutdown();
  await request(value.app).get('/readyz').expect(503, { status: 'not_ready' });
});

test('metrics returns the shared Prometheus content type', async () => {
  const value = fixture();
  const response = await request(value.app).get('/metrics').expect(200);
  assert.match(response.headers['content-type'], /text\/plain/);
  assert.match(response.text, /fanout/);
});

test('readiness failure is 503 and does not expose database details', async () => {
  const readiness = createReadiness();
  const errors = [];
  const app = createOpsApp({
    db: { pool: { query: async () => { throw new Error('postgres://secret'); } } },
    metrics: { register: { contentType: 'text/plain', metrics: async () => '' } },
    logger: { error(...args) { errors.push(args); }, info() {} },
    readiness,
  });
  const response = await request(app).get('/readyz').expect(503);
  assert.deepEqual(response.body, { status: 'not_ready' });
  assert.doesNotMatch(JSON.stringify(response.body), /postgres/);
  assert.equal(errors.length, 1);
});
