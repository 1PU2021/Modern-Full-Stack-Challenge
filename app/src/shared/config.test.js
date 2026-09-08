'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./config');

const baseEnv = {
  DATABASE_URL: 'postgres://app_user:pw@localhost:5432/notifications',
  APP_DATABASE_URL: 'postgres://app_user:app_user@localhost:5432/notify',
  AWS_REGION: 'us-east-2',
  ALERT_FANOUT_QUEUE_URL: 'http://localhost:9324/queue/alert-fanout',
  RECIPIENT_DISPATCH_QUEUE_URL: 'http://localhost:9324/queue/recipient-dispatch',
  JWT_SECRET: 'dev-secret',
  PLATFORM_JWT_SECRET: 'dev-platform-secret',
};

test('loadConfig applies defaults for optional values', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.port, 3000);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.maxDeliveryAttempts, 5);
  assert.equal(config.demoUserPassword, 'demo-only-change-me');
  assert.equal(config.aws.sqsEndpoint, undefined);
  assert.equal(config.geocoder.provider, 'none');
  assert.equal(config.geocoder.userAgent, undefined);
});

test('loadConfig maps a configured geocoder provider and user agent through', () => {
  const config = loadConfig({ ...baseEnv, GEOCODER_PROVIDER: 'nominatim', GEOCODER_USER_AGENT: 'demo-app (ops@example.test)' });
  assert.equal(config.geocoder.provider, 'nominatim');
  assert.equal(config.geocoder.userAgent, 'demo-app (ops@example.test)');
});

test('loadConfig rejects an unknown GEOCODER_PROVIDER rather than silently defaulting', () => {
  assert.throws(() => loadConfig({ ...baseEnv, GEOCODER_PROVIDER: 'google' }));
});

test('loadConfig maps required and overridden values through', () => {
  const config = loadConfig({ ...baseEnv, PORT: '4100', NODE_ENV: 'production', DEMO_USER_PASSWORD: 'configured-demo-password' });
  assert.equal(config.databaseUrl, baseEnv.DATABASE_URL);
  assert.equal(config.appDatabaseUrl, baseEnv.APP_DATABASE_URL);
  assert.equal(config.aws.region, baseEnv.AWS_REGION);
  assert.equal(config.queues.alertFanoutUrl, baseEnv.ALERT_FANOUT_QUEUE_URL);
  assert.equal(config.queues.recipientDispatchUrl, baseEnv.RECIPIENT_DISPATCH_QUEUE_URL);
  assert.equal(config.jwtSecret, 'dev-secret');
  assert.equal(config.platformJwtSecret, 'dev-platform-secret');
  assert.equal(config.port, 4100);
  assert.equal(config.nodeEnv, 'production');
  assert.equal(config.demoUserPassword, 'configured-demo-password');
});

test('loadConfig throws a readable error listing every missing required var', () => {
  assert.throws(
    () => loadConfig({}),
    (err) => {
      assert.match(err.message, /DATABASE_URL is required/);
      assert.match(err.message, /APP_DATABASE_URL is required/);
      assert.match(err.message, /AWS_REGION is required/);
      assert.match(err.message, /ALERT_FANOUT_QUEUE_URL is required/);
      assert.match(err.message, /RECIPIENT_DISPATCH_QUEUE_URL is required/);
      assert.match(err.message, /JWT_SECRET is required/);
      assert.match(err.message, /PLATFORM_JWT_SECRET is required/);
      return true;
    }
  );
});

test('loadConfig rejects an invalid NODE_ENV rather than silently defaulting', () => {
  assert.throws(() => loadConfig({ ...baseEnv, NODE_ENV: 'staging' }));
});
