'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout } = require('node:timers');
const execFileAsync = promisify(execFile);

async function waitForHttp(url, { fetchImpl = globalThis.fetch, timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return response;
    } catch { /* dependency is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function runSmoke({
  runCommand = async (args) => execFileAsync(args[0], args.slice(1)),
  fetchImpl = globalThis.fetch,
  baseUrl = 'http://localhost:3000',
  timeoutMs = 60_000,
  intervalMs = 1_000,
  pollIntervalMs = 2_000,
} = {}) {
  const up = ['docker', 'compose', 'up', '--build', '-d'];
  const down = ['docker', 'compose', 'down'];
  await runCommand(up);
  try {
    await waitForHttp(`${baseUrl}/readyz`, { fetchImpl, timeoutMs, intervalMs });
    const login = await fetchImpl(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo-county.test', password: 'demo-only-change-me' }),
    });
    if (!login.ok) throw new Error(`Demo login failed with ${login.status}`);
    const { token } = await login.json();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const { DEMO_POLYGON } = await import('../web/src/demo-geography.js');
    const submitted = await fetchImpl(`${baseUrl}/api/v1/alerts`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: 'Local geographic smoke alert', body: 'Demo polygon pipeline', channels: ['sms'], target: { type: 'polygon', geojson: DEMO_POLYGON } }),
    });
    if (!submitted.ok) throw new Error(`Alert submission failed with ${submitted.status}`);
    const { alertId } = await submitted.json();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await fetchImpl(`${baseUrl}/api/v1/alerts/${alertId}/deliveries`, { headers });
      if (response.ok) {
        const deliveries = await response.json();
        if (deliveries.length === 22 && deliveries.some((delivery) => delivery.attemptCount > 0)) {
          return { alertId, deliveryCount: deliveries.length, dispatched: true };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`Timed out waiting for alert ${alertId} delivery`);
  } finally {
    await runCommand(down);
  }
}

if (require.main === module) runSmoke().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = { waitForHttp, runSmoke };
