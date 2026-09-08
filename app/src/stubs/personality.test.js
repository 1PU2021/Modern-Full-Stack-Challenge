'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderPersonality } = require('./personality');

function base(options = {}) {
  return createProviderPersonality({
    channel: 'sms', normalLatency: [0, 0], degradedLatency: [0, 0], failureRate: 0, degradedFailureRate: 0,
    capacity: 1, refillPerSecond: 0, degradationProbability: 0, random: () => 0.9, now: () => 0, sleep: async () => {}, ...options,
  });
}

test('personality returns successful provider response after latency', async () => {
  const result = await base().handle({ body: { deliveryId: 'd' } });
  assert.deepEqual(result, { status: 202, body: { accepted: true, channel: 'sms' } });
});

test('personality returns rate limited with Retry-After when token bucket is empty', async () => {
  const personality = base({ capacity: 1 });
  await personality.handle({ body: {} });
  const result = await personality.handle({ body: {} });
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '1');
});

test('personality supports deterministic failures and correlated degradation', async () => {
  let current = 100;
  const personality = base({ capacity: 10, failureRate: 1, now: () => current, degradationProbability: 1, degradedFailureRate: 1, degradationDuration: [1000, 1000] });
  const first = await personality.handle({ body: {} });
  assert.equal(first.status, 502);
  current = 500;
  const second = await personality.handle({ body: {} });
  assert.equal(second.status, 502);
});

test('email personality can deliberately hang using injected sleep', async () => {
  const waits = [];
  const personality = base({ channel: 'email', capacity: 10, hangRate: 1, sleep: async (ms) => waits.push(ms) });
  await personality.handle({ body: {} });
  assert.equal(waits.length, 2);
  assert.ok(waits[1] >= 25_000 && waits[1] <= 32_000);
});
