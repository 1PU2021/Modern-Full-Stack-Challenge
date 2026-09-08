'use strict';

const { setTimeout } = require('node:timers/promises');

function sleepDefault(ms, { abortSignal } = {}) {
  return setTimeout(ms, undefined, { signal: abortSignal });
}

function randomBetween(random, range) {
  return range[0] + (range[1] - range[0]) * random();
}

function createProviderPersonality(options) {
  const {
    channel,
    normalLatency = channel === 'email' ? [300, 900] : [100, 300],
    degradedLatency = channel === 'email' ? [2000, 5000] : [800, 2000],
    failureRate = channel === 'email' ? 0.01 : 0.02,
    degradedFailureRate = channel === 'email' ? 0.15 : 0.35,
    capacity = channel === 'email' ? 200 : 50,
    refillPerSecond = channel === 'email' ? 100 : 30,
    degradationProbability = 0.01,
    degradationDuration = [30_000, 90_000],
    hangRate = channel === 'email' ? 0.01 : 0,
    random = Math.random,
    now = () => Date.now(),
    sleep = sleepDefault,
  } = options;
  let tokens = capacity;
  let lastRefill = now();
  let degradeUntil = 0;

  async function handle(request, { abortSignal } = {}) {
    void request;
    const current = now();
    tokens = Math.min(capacity, tokens + Math.max(0, current - lastRefill) / 1000 * refillPerSecond);
    lastRefill = current;
    if (tokens < 1) return { status: 429, headers: { 'retry-after': '1' }, body: { error: 'rate_limited' } };
    tokens -= 1;

    if (current >= degradeUntil && random() < degradationProbability) {
      degradeUntil = current + randomBetween(random, degradationDuration);
    }
    const degraded = current < degradeUntil;
    const latency = randomBetween(random, degraded ? degradedLatency : normalLatency);
    await sleep(latency, { abortSignal });
    if (channel === 'email' && random() < hangRate) {
      await sleep(randomBetween(random, [25_000, 32_000]), { abortSignal });
    }
    if (random() < (degraded ? degradedFailureRate : failureRate)) {
      return { status: 502, body: { error: 'provider_unavailable', degraded } };
    }
    return { status: 202, body: { accepted: true, channel } };
  }

  return { handle };
}

module.exports = { createProviderPersonality };
