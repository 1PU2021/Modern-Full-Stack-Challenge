'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('./db');

function fakeClient() {
  const queries = [];
  let clientReleased = false;
  return {
    queries,
    isReleased: () => clientReleased,
    query(text, params) {
      queries.push({ text, params });
      return Promise.resolve({ rows: [] });
    },
    release() {
      clientReleased = true;
    },
  };
}

function fakePool(client) {
  return { connect: () => Promise.resolve(client) };
}

test('withTenant scopes the session to the tenant before running the callback', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  await db.withTenant('11111111-1111-1111-1111-111111111111', async (c) => {
    assert.equal(c, client);
    return 'ok';
  });

  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(client.queries[1].text, 'SELECT set_config($1, $2, true)');
  assert.deepEqual(client.queries[1].params, [
    'app.current_tenant',
    '11111111-1111-1111-1111-111111111111',
  ]);
  assert.equal(client.queries[2].text, 'COMMIT');
  assert.equal(client.isReleased(), true);
});

test('withTenant returns the callback result', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  const result = await db.withTenant('11111111-1111-1111-1111-111111111111', async () => 42);
  assert.equal(result, 42);
});

test('withTenant rolls back and releases the client when the callback throws', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  await assert.rejects(
    () =>
      db.withTenant('11111111-1111-1111-1111-111111111111', async () => {
        throw new Error('boom');
      }),
    /boom/
  );

  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(client.isReleased(), true);
});

test('withTenant rejects a malformed tenant id before touching the database', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  await assert.rejects(
    () => db.withTenant('not-a-uuid', async () => 'unreachable'),
    /not a valid tenant id/
  );
  assert.equal(client.queries.length, 0);
});
