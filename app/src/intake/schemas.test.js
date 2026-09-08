'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAlertRequest, parseUuidParam } = require('./schemas');

const GROUP_ID = '11111111-1111-1111-1111-111111111111';

function validGroupBody() {
  return {
    title: 'Storm warning',
    body: 'Take shelter now',
    channels: ['sms'],
    target: { type: 'group', groupId: GROUP_ID },
  };
}

function validPolygonBody(coordinates = [[[0, 0], [1, 0], [0, 1], [0, 0]]]) {
  return {
    ...validGroupBody(),
    target: { type: 'polygon', geojson: { type: 'Polygon', coordinates } },
  };
}

function closedRing(positionCount, offset = 0) {
  const uniqueCount = positionCount - 1;
  const ring = Array.from({ length: uniqueCount }, (_, index) => [
    offset + (index % 100) / 1000,
    Math.floor(index / 100) / 1000,
  ]);
  ring.push([...ring[0]]);
  return ring;
}

test('parseAlertRequest defaults priority, generates a key, and canonicalizes channels', () => {
  const value = parseAlertRequest({
    body: { ...validGroupBody(), channels: ['email', 'sms'] },
  });
  assert.equal(value.priority, 'normal');
  assert.deepEqual(value.channels, ['sms', 'email']);
  assert.match(value.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
});

test('parseAlertRequest preserves accepted text and a supplied 255-code-point key', () => {
  const key = 'Ä'.repeat(255);
  const value = parseAlertRequest({
    body: { ...validGroupBody(), title: '  Important  ', body: '  Body  ' },
    idempotencyKey: key,
  });
  assert.equal(value.title, '  Important  ');
  assert.equal(value.body, '  Body  ');
  assert.equal(value.idempotencyKey, key);
});

test('text and idempotency boundaries count Unicode code points', () => {
  assert.doesNotThrow(() =>
    parseAlertRequest({ body: { ...validGroupBody(), title: '😀'.repeat(200), body: '😀'.repeat(10_000) }, idempotencyKey: 'é'.repeat(255) })
  );
  assert.throws(() => parseAlertRequest({ body: { ...validGroupBody(), title: '😀'.repeat(201) } }), /validation_failed/);
  assert.throws(() => parseAlertRequest({ body: { ...validGroupBody(), body: '😀'.repeat(10_001) } }), /validation_failed/);
  assert.throws(() => parseAlertRequest({ body: validGroupBody(), idempotencyKey: 'é'.repeat(256) }), /validation_failed/);
});

test('rejects whitespace-only text, whitespace-only keys, and duplicate or empty channels', () => {
  assert.throws(() => parseAlertRequest({ body: { ...validGroupBody(), title: '  ' } }), /validation_failed/);
  assert.throws(() => parseAlertRequest({ body: { ...validGroupBody(), body: '\n\t' } }), /validation_failed/);
  assert.throws(() => parseAlertRequest({ body: validGroupBody(), idempotencyKey: '  ' }), /validation_failed/);
  assert.throws(() => parseAlertRequest({ body: { ...validGroupBody(), channels: [] } }), /validation_failed/);
  assert.throws(() => parseAlertRequest({ body: { ...validGroupBody(), channels: ['sms', 'sms'] } }), /validation_failed/);
});

test('group targets require a UUID and reject unknown fields', () => {
  assert.throws(() => parseAlertRequest({ body: { ...validGroupBody(), target: { type: 'group', groupId: 'x' } } }), /validation_failed/);
  assert.throws(() => parseAlertRequest({ body: { ...validGroupBody(), target: { ...validGroupBody().target, extra: true } } }), /validation_failed/);
});

test('accepts structurally sane polygon boundaries', () => {
  assert.equal(parseAlertRequest({ body: validPolygonBody() }).target.type, 'polygon');
  const twentyRings = Array.from({ length: 20 }, (_, index) => closedRing(100, index));
  assert.doesNotThrow(() => parseAlertRequest({ body: validPolygonBody(twentyRings) }));
  assert.doesNotThrow(() => parseAlertRequest({ body: validPolygonBody([closedRing(1_000)]) }));
});

test('rejects open, degenerate, 3D, non-finite, and out-of-range polygon positions', () => {
  const cases = [
    [[[0, 0], [1, 0], [0, 1], [2, 2]]],
    [[[0, 0], [1, 0], [1, 0], [0, 0]]],
    [[[0, 0, 1], [1, 0], [0, 1], [0, 0, 1]]],
    [[[0, 0], [Infinity, 0], [0, 1], [0, 0]]],
    [[[0, 0], [181, 0], [0, 1], [0, 0]]],
    [[[0, 0], [1, 91], [0, 1], [0, 0]]],
  ];
  for (const coordinates of cases) {
    assert.throws(() => parseAlertRequest({ body: validPolygonBody(coordinates) }), /validation_failed/);
  }
});

test('rejects polygon size overflow and unknown GeoJSON fields', () => {
  assert.throws(() => parseAlertRequest({ body: validPolygonBody(Array.from({ length: 21 }, (_, i) => closedRing(4, i))) }), /validation_failed/);
  assert.throws(() => parseAlertRequest({ body: validPolygonBody([closedRing(1_001)]) }), /validation_failed/);
  const overTotal = [closedRing(1_000), closedRing(1_000), closedRing(4)];
  assert.throws(() => parseAlertRequest({ body: validPolygonBody(overTotal) }), /validation_failed/);
  const body = validPolygonBody();
  body.target.geojson.bbox = [0, 0, 1, 1];
  assert.throws(() => parseAlertRequest({ body }), /validation_failed/);
});

test('parseUuidParam returns UUIDs and reports the named invalid path', () => {
  assert.equal(parseUuidParam(GROUP_ID, 'alertId'), GROUP_ID);
  assert.throws(
    () => parseUuidParam('not-a-uuid', 'alertId'),
    (error) => error.code === 'validation_failed' && error.details[0].path === 'alertId'
  );
});

module.exports = { validGroupBody, validPolygonBody, closedRing };
