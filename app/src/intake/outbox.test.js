'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate } = require('node:timers');
const { createOutboxPublisher, retryDelaySeconds } = require('./outbox');

const logger = { info() {}, error() {} };

test('retryDelaySeconds uses capped exponential backoff', () => {
  assert.deepEqual(Array.from({ length: 8 }, (_, index) => retryDelaySeconds(index + 1)),
    [1, 2, 4, 8, 16, 32, 60, 60]);
});

test('a claim sends its exact payload and records success', async () => {
  const claim = { id: 'event', tenantId: 'tenant', claimToken: 'token', payload: { eventId: 'event' } };
  const sent = [];
  const successes = [];
  let publisher;
  const store = {
    listTenantIds: async () => ['tenant'],
    claimNext: async () => claim,
    recordSuccess: async (value) => { successes.push(value); void publisher.stop(); },
    recordFailure: async () => assert.fail('unexpected failure'),
  };
  publisher = createOutboxPublisher({ store, logger, send: async (value) => sent.push(value) });
  publisher.start();
  await publisher.done;
  assert.deepEqual(sent, [claim]);
  assert.deepEqual(successes, [claim]);
});

test('send failure records failure and continues', async () => {
  let claims = 0;
  let publisher;
  const failures = [];
  const store = {
    listTenantIds: async () => ['tenant'],
    claimNext: async () => (++claims === 1 ? { id: 'e', tenantId: 'tenant', claimToken: 't' } : null),
    recordSuccess: async () => assert.fail('unexpected success'),
    recordFailure: async (claim, error) => failures.push([claim.id, error.message]),
  };
  publisher = createOutboxPublisher({
    store,
    logger,
    send: async () => { throw new Error('SQS unavailable'); },
    sleep: async () => { void publisher.stop(); },
  });
  publisher.start();
  await publisher.done;
  assert.deepEqual(failures, [['e', 'SQS unavailable']]);
  assert.ok(claims >= 2);
});

test('stop waits for an active send and prevents another claim', async () => {
  let release;
  const active = new Promise((resolve) => { release = resolve; });
  let claims = 0;
  const store = {
    listTenantIds: async () => ['tenant'],
    claimNext: async () => { claims += 1; return { id: 'e', tenantId: 'tenant' }; },
    recordSuccess: async () => {},
    recordFailure: async () => {},
  };
  const publisher = createOutboxPublisher({ store, logger, send: async () => active });
  publisher.start();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = publisher.stop();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(claims, 1);
});

test('abort cancels the active send without recording a result', async () => {
  let signal;
  const results = [];
  const store = {
    listTenantIds: async () => ['tenant'],
    claimNext: async () => ({ id: 'e', tenantId: 'tenant' }),
    recordSuccess: async () => results.push('success'),
    recordFailure: async () => results.push('failure'),
  };
  const publisher = createOutboxPublisher({
    store,
    logger,
    send: async (claim, options) => {
      void claim;
      signal = options.abortSignal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
      }));
    },
  });
  publisher.start();
  await new Promise((resolve) => setImmediate(resolve));
  await publisher.abort();
  assert.equal(signal.aborted, true);
  assert.deepEqual(results, []);
});

test('no work sleeps 500 ms and stop interrupts idle sleep', async () => {
  const sleeps = [];
  let publisher;
  const store = { listTenantIds: async () => ['tenant'], claimNext: async () => null };
  publisher = createOutboxPublisher({
    store,
    logger,
    send: async () => {},
    sleep: async (ms, { abortSignal }) => {
      sleeps.push(ms);
      void publisher.stop();
      assert.equal(abortSignal.aborted, true);
    },
  });
  publisher.start();
  await publisher.done;
  assert.deepEqual(sleeps, [500]);
});

test('claims at most one row per tenant in each round-robin pass', async () => {
  const order = [];
  let publisher;
  const store = {
    listTenantIds: async () => ['a', 'b'],
    claimNext: async (tenantId) => {
      order.push(tenantId);
      if (order.length === 4) void publisher.stop();
      return null;
    },
  };
  publisher = createOutboxPublisher({
    store,
    logger,
    send: async () => {},
    sleep: async () => {},
  });
  publisher.start();
  await publisher.done;
  assert.deepEqual(order, ['a', 'b', 'a', 'b']);
});
