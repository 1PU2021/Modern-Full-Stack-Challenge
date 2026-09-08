'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { parseDispatchJob, PermanentDispatchError } = require('./schemas');

test('parseDispatchJob accepts the exact fanout job contract', () => {
  const job = { deliveryId: randomUUID(), alertId: randomUUID(), tenantId: randomUUID(), recipientId: randomUUID(), channel: 'sms' };
  assert.deepEqual(parseDispatchJob(JSON.stringify(job)), job);
});

test('parseDispatchJob rejects malformed or extra fields without retaining raw input', () => {
  assert.throws(() => parseDispatchJob('{"secret":"do-not-log"}'), (error) => {
    assert.ok(error instanceof PermanentDispatchError);
    assert.equal(error.reason, 'invalid_message');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});

test('parseDispatchJob only accepts sms and email channels', () => {
  const base = { deliveryId: randomUUID(), alertId: randomUUID(), tenantId: randomUUID(), recipientId: randomUUID() };
  assert.throws(() => parseDispatchJob(JSON.stringify({ ...base, channel: 'voice' })), PermanentDispatchError);
});
