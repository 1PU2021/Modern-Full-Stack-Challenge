'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createFanoutStore } = require('./store');

const tenantId = randomUUID();
const alertId = randomUUID();
const polygonRow = {
  id: alertId,
  tenant_id: tenantId,
  channels: ['sms'],
  status: 'accepted',
  target: {
    type: 'polygon',
    geojson: {
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    },
  },
};

test('polygon database connectivity failures remain retryable', async () => {
  const connectionError = Object.assign(new Error('connection lost'), { code: '08006' });
  let queryCount = 0;
  const client = {
    async query() {
      queryCount += 1;
      if (queryCount === 1) return { rows: [polygonRow] };
      if (queryCount === 2) return { rowCount: 1, rows: [] };
      throw connectionError;
    },
  };
  const db = { withTenant: async (id, fn) => fn(client) };
  const store = createFanoutStore({ db });
  await assert.rejects(
    () => store.materialize({ eventId: randomUUID(), alertId, tenantId }),
    (error) => error === connectionError
  );
});
