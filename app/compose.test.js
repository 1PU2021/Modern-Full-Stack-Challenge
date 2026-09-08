'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Dockerfile uses the package runtime and lockfile install', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  assert.match(dockerfile, /^FROM node:22-/m);
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /COPY package\.json package-lock\.json/);
});

test('ElasticMQ declares both application queues', () => {
  const config = fs.readFileSync('elasticmq.conf', 'utf8');
  assert.match(config, /alert-fanout/);
  assert.match(config, /recipient-dispatch/);
});
