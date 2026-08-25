'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('./logger');

test('createLogger tags every log line with the service name', () => {
  const logger = createLogger('intake');
  assert.equal(logger.bindings().service, 'intake');
});

test('createLogger defaults to info level', () => {
  const logger = createLogger('intake');
  assert.equal(logger.level, 'info');
});

test('createLogger honors an explicit level', () => {
  const logger = createLogger('dispatch', { level: 'debug' });
  assert.equal(logger.level, 'debug');
});

test('createLogger children carry request-scoped fields alongside the service name', () => {
  const logger = createLogger('intake');
  const child = logger.child({ tenant_id: 't-1', alert_id: 'a-1', channel: 'sms' });
  assert.equal(child.bindings().tenant_id, 't-1');
  assert.equal(child.bindings().alert_id, 'a-1');
  assert.equal(child.bindings().channel, 'sms');
  assert.equal(child.bindings().service, 'intake');
});
