'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startStubs } = require('./index');

test('startStubs creates both channel servers and closes them together', async () => {
  const calls = [];
  const servers = [{ close(cb) { calls.push('sms'); cb(); } }, { close(cb) { calls.push('email'); cb(); } }];
  let index = 0;
  const result = startStubs({ listen: () => servers[index++] });
  await result.close();
  assert.deepEqual(calls, ['sms', 'email']);
});
