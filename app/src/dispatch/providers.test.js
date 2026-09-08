'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyProviderResponse, createProviderClient } = require('./providers');

test('classifyProviderResponse maps success, retryable, timeout, and permanent HTTP outcomes', () => {
  assert.deepEqual(classifyProviderResponse({ status: 202 }), { outcome: 'delivered', retryable: false, permanent: false });
  assert.deepEqual(classifyProviderResponse({ status: 429 }), { outcome: 'rate_limited', retryable: true, permanent: false });
  assert.deepEqual(classifyProviderResponse({ status: 408 }), { outcome: 'timed_out', retryable: true, permanent: false });
  assert.deepEqual(classifyProviderResponse({ status: 504 }), { outcome: 'timed_out', retryable: true, permanent: false });
  assert.deepEqual(classifyProviderResponse({ status: 502 }), { outcome: 'failed', retryable: true, permanent: false });
  assert.deepEqual(classifyProviderResponse({ status: 400 }), { outcome: 'failed', retryable: false, permanent: true });
});

test('provider client sends channel payload and parses bounded success response', async () => {
  const calls = [];
  const client = createProviderClient({
    urls: { sms: 'http://sms.test/send', email: 'http://email.test/send' },
    fetchImpl: async (...args) => {
      calls.push(args);
      return { status: 200, text: async () => JSON.stringify({ providerId: 'p-1' }) };
    },
    timeoutMs: 100,
  });
  const result = await client.send({ channel: 'sms', deliveryId: 'd', alertId: 'a', tenantId: 't', recipientId: 'r' });
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(calls[0][0], 'http://sms.test/send');
  assert.equal(JSON.parse(calls[0][1].body).deliveryId, 'd');
});

test('provider client classifies network failures and aborts', async () => {
  const client = createProviderClient({
    urls: { sms: 'http://sms.test', email: 'http://email.test' },
    fetchImpl: async () => { throw new Error('offline'); },
    timeoutMs: 100,
  });
  const failed = await client.send({ channel: 'email' });
  assert.deepEqual(failed, { outcome: 'failed', retryable: true, permanent: false, response: { reason: 'network_error' } });

  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(() => client.send({ channel: 'sms' }, { abortSignal: controller.signal }), { name: 'AbortError' });
});

test('provider client classifies an internal timeout as timed_out', async () => {
  const client = createProviderClient({
    urls: { sms: 'http://sms.test', email: 'http://email.test' },
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 5,
  });
  const result = await client.send({ channel: 'sms' });
  assert.deepEqual(result, { outcome: 'timed_out', retryable: true, permanent: false, response: { reason: 'timeout' } });
});
