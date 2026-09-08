'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseFanoutEvent, parseStoredAlert, PermanentFanoutError } = require('./schemas');

const event = { eventId: randomUUID(), alertId: randomUUID(), tenantId: randomUUID() };
const row = {
  id: event.alertId,
  tenant_id: event.tenantId,
  channels: ['email', 'sms'],
  target: { type: 'group', groupId: randomUUID() },
  status: 'accepted',
};

test('parseFanoutEvent accepts only the exact UUID event contract', () => {
  assert.deepEqual(parseFanoutEvent(JSON.stringify(event)), event);
  for (const body of [
    '{',
    JSON.stringify({ ...event, eventId: 'bad' }),
    JSON.stringify({ ...event, extra: true }),
  ]) {
    assert.throws(
      () => parseFanoutEvent(body),
      (error) => error instanceof PermanentFanoutError && error.reason === 'invalid_event'
    );
  }
});

test('parseFanoutEvent errors never retain the raw body', () => {
  const secret = 'raw-secret-message';
  assert.throws(() => parseFanoutEvent(secret), (error) => {
    assert.doesNotMatch(JSON.stringify(error), /raw-secret-message/);
    return true;
  });
});

test('parseStoredAlert canonicalizes valid channels and group targets', () => {
  assert.deepEqual(parseStoredAlert(row), {
    id: row.id,
    tenantId: row.tenant_id,
    channels: ['sms', 'email'],
    target: row.target,
    status: 'accepted',
  });
});

test('parseStoredAlert accepts structurally sane polygons', () => {
  const target = {
    type: 'polygon',
    geojson: {
      type: 'Polygon',
      coordinates: [[[-86, 39], [-85, 39], [-85, 40], [-86, 39]]],
    },
  };
  assert.deepEqual(parseStoredAlert({ ...row, target }).target, target);
});

test('parseStoredAlert rejects corrupt channels, targets, and polygon structure', () => {
  const invalid = [
    { ...row, channels: ['voice'] },
    { ...row, target: { type: 'group', groupId: 'bad' } },
    { ...row, target: { type: 'polygon', geojson: { type: 'Polygon', coordinates: [] } } },
    {
      ...row,
      target: {
        type: 'polygon',
        geojson: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
      },
    },
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseStoredAlert(value),
      (error) => error instanceof PermanentFanoutError && error.reason === 'invalid_stored_alert'
    );
  }
});
