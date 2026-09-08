'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForHttp, runSmoke } = require('./smoke-local-stack');

test('waitForHttp polls until a successful response', async () => {
  let attempts = 0;
  await waitForHttp('http://service/readyz', { fetchImpl: async () => ({ ok: ++attempts > 1 }), timeoutMs: 100, intervalMs: 1 });
  assert.equal(attempts, 2);
});

test('runSmoke starts, logs in, submits the demo polygon, observes dispatch work, and tears down', async () => {
  const commands = [];
  const responses = [
    { ok: true },
    { ok: true, json: async () => ({ token: 'token-1' }) },
    { ok: true, status: 202, json: async () => ({ alertId: 'a1' }) },
    { ok: true, json: async () => Array.from({ length: 22 }, (_, index) => ({ status: 'pending', attemptCount: index ? 0 : 1 })) },
  ];
  const requests = [];
  const result = await runSmoke({
    runCommand: async (command) => { commands.push(command); return 'token-1'; },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return responses.shift(); },
    baseUrl: 'http://local',
    pollIntervalMs: 1,
  });
  assert.deepEqual(result, { alertId: 'a1', deliveryCount: 22, dispatched: true });
  assert.equal(requests[1].url, 'http://local/api/auth/login');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    email: 'admin@demo-county.test', password: 'demo-only-change-me',
  });
  assert.match(requests[2].options.body, /"type":"polygon"/);
  assert.deepEqual(commands, [['docker', 'compose', 'up', '--build', '-d'], ['docker', 'compose', 'down']]);
});

test('runSmoke always tears down when readiness or delivery fails', async () => {
  const commands = [];
  await assert.rejects(() => runSmoke({
    runCommand: async (command) => { commands.push(command); },
    fetchImpl: async () => ({ ok: false }),
    baseUrl: 'http://local', timeoutMs: 5, intervalMs: 1,
  }));
  assert.deepEqual(commands.at(-1), ['docker', 'compose', 'down']);
});
