'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const compose = () => fs.readFileSync('docker-compose.yml', 'utf8');

test('Compose includes dependencies, init jobs, and all backend services', () => {
  const text = compose();
  for (const service of ['postgres:', 'elasticmq:', 'migrate:', 'seed:', 'stubs:', 'intake:', 'fanout:', 'dispatch:']) assert.match(text, new RegExp(`^  ${service}`, 'm'));
  assert.match(text, /service_healthy/);
  assert.match(text, /service_completed_successfully/);
  assert.match(text, /"npm", "run", "migrate", "up"/);
  assert.match(text, /"npm", "run", "seed"/);
});

test('Compose preserves admin/app DB split and required queue URLs', () => {
  const text = compose();
  assert.match(text, /DATABASE_URL: postgres:\/\/postgres:postgres@postgres:5432\/notifications/);
  assert.match(text, /APP_DATABASE_URL: postgres:\/\/app_user:app_user@postgres:5432\/notifications/);
  assert.match(text, /ALERT_FANOUT_QUEUE_URL: http:\/\/elasticmq:9324\/queue\/alert-fanout/);
  assert.match(text, /RECIPIENT_DISPATCH_QUEUE_URL: http:\/\/elasticmq:9324\/queue\/recipient-dispatch/);
  assert.match(text, /\$\{POSTGRES_PORT:-5432\}:5432/);
});

test('Compose does not add a frontend service', () => {
  assert.doesNotMatch(compose(), /^  frontend:/m);
});

test('Compose gates long-running services on health and restarts only durable roles', () => {
  const text = compose();
  for (const service of ['intake', 'fanout', 'dispatch']) {
    const block = text.match(new RegExp(`  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:|\\nvolumes:)`))?.[0] || '';
    assert.match(block, /healthcheck:/);
    assert.match(block, /restart: unless-stopped/);
  }
  const web = text.match(/  web:\n([\s\S]*?)(?=\nvolumes:)/)?.[0] || '';
  assert.match(web, /intake:\n\s+condition: service_healthy/);
  for (const job of ['migrate', 'seed']) {
    const block = text.match(new RegExp(`  ${job}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:)`))?.[0] || '';
    assert.doesNotMatch(block, /restart:/);
  }
});

test('Compose supplies the configurable demo password only where login and seed require it', () => {
  const text = compose();
  assert.match(text, /DEMO_USER_PASSWORD: \$\{DEMO_USER_PASSWORD:-demo-only-change-me\}/);
});

test('Compose supplies a PLATFORM_JWT_SECRET distinct from JWT_SECRET to every service that loads config', () => {
  const text = compose();
  const jwtSecretCount = (text.match(/JWT_SECRET: \$\{JWT_SECRET:-dev-secret-change-me\}/g) || []).length;
  const platformJwtSecretCount = (text.match(/PLATFORM_JWT_SECRET: \$\{PLATFORM_JWT_SECRET:-dev-platform-secret-change-me\}/g) || []).length;
  assert.ok(jwtSecretCount > 0);
  assert.equal(platformJwtSecretCount, jwtSecretCount, 'every service configured with JWT_SECRET must also get PLATFORM_JWT_SECRET');
});
