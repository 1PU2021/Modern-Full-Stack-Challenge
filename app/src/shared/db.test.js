'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('./db');

function fakeClient({ rollbackError } = {}) {
  const queries = [];
  let clientReleased = false;
  let releaseArg;
  return {
    queries,
    isReleased: () => clientReleased,
    releaseArg: () => releaseArg,
    query(text, params) {
      queries.push({ text, params });
      if (text === 'ROLLBACK' && rollbackError) {
        return Promise.reject(rollbackError);
      }
      return Promise.resolve({ rows: [] });
    },
    release(err) {
      clientReleased = true;
      releaseArg = err;
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

test('withTenant preserves the original error and destroys the client when ROLLBACK itself fails', async () => {
  const rollbackError = new Error('connection terminated');
  const client = fakeClient({ rollbackError });
  const db = createDb(fakePool(client));

  await assert.rejects(
    () =>
      db.withTenant('11111111-1111-1111-1111-111111111111', async () => {
        throw new Error('boom');
      }),
    /boom/
  );

  assert.equal(client.isReleased(), true);
  assert.equal(client.releaseArg(), rollbackError);
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

test('withPlatformProvisioningTransaction opens one transaction and lets the callback scope RLS mid-flight', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));
  const newTenantId = '33333333-3333-3333-3333-333333333333';

  const result = await db.withPlatformProvisioningTransaction(async (c, scopeToTenant) => {
    assert.equal(c, client);
    // The tenant doesn't exist yet at BEGIN time -- only the callback knows
    // its id once it inserts the row, which is the entire point of this
    // helper over a plain withTenant(existingId, ...) call.
    await scopeToTenant(newTenantId);
    return 'provisioned';
  });

  assert.equal(result, 'provisioned');
  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(client.queries[1].text, 'SELECT set_config($1, $2, true)');
  assert.deepEqual(client.queries[1].params, ['app.current_tenant', newTenantId]);
  assert.equal(client.queries.at(-1).text, 'COMMIT');
  assert.equal(client.isReleased(), true);
});

test('withPlatformProvisioningTransaction rolls back and releases the client when the callback throws', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  await assert.rejects(
    () => db.withPlatformProvisioningTransaction(async () => {
      throw new Error('tenant insert failed');
    }),
    /tenant insert failed/
  );

  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(client.isReleased(), true);
});

test('withPlatformProvisioningTransaction rejects scopeToTenant being called with a malformed id', async () => {
  const client = fakeClient();
  const db = createDb(fakePool(client));

  await assert.rejects(
    () => db.withPlatformProvisioningTransaction(async (c, scopeToTenant) => {
      await scopeToTenant('not-a-uuid');
    }),
    /not a valid tenant id/
  );
  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
});
