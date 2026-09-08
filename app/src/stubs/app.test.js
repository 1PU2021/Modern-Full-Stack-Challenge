'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createStubApp } = require('./app');

test('stub app exposes channel send and health routes', async () => {
  const app = createStubApp({ channel: 'sms', personality: { handle: async () => ({ status: 202, body: { accepted: true } }) } });
  assert.equal((await request(app).get('/healthz')).status, 200);
  const response = await request(app).post('/sms/send').send({ deliveryId: 'd' });
  assert.equal(response.status, 202);
});

test('stub app maps malformed request and personality response safely', async () => {
  const app = createStubApp({ channel: 'email', personality: { handle: async () => ({ status: 429, headers: { 'retry-after': '2' }, body: { error: 'limited' } }) } });
  const response = await request(app).post('/email/send').send({});
  assert.equal(response.status, 429);
  assert.equal(response.headers['retry-after'], '2');
});
