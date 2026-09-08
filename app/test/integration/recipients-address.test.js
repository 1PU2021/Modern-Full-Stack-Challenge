'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const request = require('supertest');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const { createIntakeFixture } = require('./support/intake');
const { GeocodeError } = require('../../src/intake/geocoder');
const { loadConfig } = require('../../src/shared/config');
const { createDb, createPool } = require('../../src/shared/db');
const { createFanoutStore } = require('../../src/fanout/store');

const tenantA = randomUUID();
const tenantB = randomUUID();
const adminA = randomUUID();
const adminB = randomUUID();
let fixture;

// A controllable stub: each test sets its own behavior via setGeocodeImpl
// rather than standing up a separate app/pool per test.
let geocodeImpl;
function setGeocodeImpl(fn) {
  geocodeImpl = fn;
}
async function controllableGeocode(address) {
  return geocodeImpl(address);
}

async function clearRows() {
  await withSuperuserClient(async (client) => {
    await client.query('DELETE FROM alert_outbox');
    await client.query('DELETE FROM idempotency_keys');
    await client.query('DELETE FROM deliveries');
    await client.query('DELETE FROM alerts');
    await client.query('DELETE FROM group_members');
    await client.query('DELETE FROM groups');
    await client.query('DELETE FROM recipients');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM tenants');
    await client.query(
      `INSERT INTO tenants (id, name, slug, tenant_type)
       VALUES ($1, 'Address Tenant A', 'recipients-address-tenant-a', 'county_em'),
              ($2, 'Address Tenant B', 'recipients-address-tenant-b', 'school_district')`,
      [tenantA, tenantB]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, 'admin-a@example.test', 'x', 'tenant_admin'),
              ($3, $4, 'admin-b@example.test', 'x', 'tenant_admin')`,
      [adminA, tenantA, adminB, tenantB]
    );
  });
}

function as(userId, tenantId, role) {
  return fixture.sign({ tenantId, userId, role });
}

function agentFor(userId, tenantId, role) {
  return {
    get: (path) => request(fixture.app).get(path).set('Authorization', `Bearer ${as(userId, tenantId, role)}`),
    post: (path) => request(fixture.app).post(path).set('Authorization', `Bearer ${as(userId, tenantId, role)}`),
    patch: (path) => request(fixture.app).patch(path).set('Authorization', `Bearer ${as(userId, tenantId, role)}`),
  };
}

const VALID_ADDRESS = {
  addressLine1: '123 Main St', city: 'Rochester', state: 'IN', postalCode: '46975',
};

let fanoutPool;
let fanoutStore;

function fanoutEvent(alertId) {
  return { eventId: randomUUID(), alertId, tenantId: tenantA };
}

async function insertAlert(target) {
  const alertId = randomUUID();
  await withSuperuserClient((client) => client.query(
    `INSERT INTO alerts (id, tenant_id, created_by, title, body, channels, target)
     VALUES ($1,$2,$3,'Fanout','Body',$4,$5::jsonb)`,
    [alertId, tenantA, adminA, ['sms'], JSON.stringify(target)]
  ));
  return alertId;
}

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture({ geocode: controllableGeocode });
  fanoutPool = createPool(loadConfig().appDatabaseUrl);
  fanoutStore = createFanoutStore({ db: createDb(fanoutPool) });
});
beforeEach(() => {
  setGeocodeImpl(async () => { throw new GeocodeError('no impl set for this test', { code: 'not_configured' }); });
  return clearRows();
});
after(async () => {
  await fixture?.pool.end();
  await fanoutPool?.end();
});

test('a valid address is geocoded and stored as the derived location', async () => {
  setGeocodeImpl(async (address) => {
    assert.deepEqual(address, { ...VALID_ADDRESS, addressLine2: null, country: 'US' });
    return { latitude: 41.0645, longitude: -86.2183, formattedAddress: 'Rochester, IN 46975, USA' };
  });
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const created = await admin.post('/api/v1/recipients').send({ name: 'Jamie Rivera', ...VALID_ADDRESS }).expect(201);
  assert.equal(created.body.addressLine1, '123 Main St');
  assert.equal(created.body.city, 'Rochester');
  assert.equal(created.body.country, 'US', 'country defaults to US when omitted');
  assert.equal(created.body.longitude, -86.2183);
  assert.equal(created.body.latitude, 41.0645);
});

test('an unresolvable address is rejected with a clear validation error, not silently stored', async () => {
  setGeocodeImpl(async () => {
    throw new GeocodeError('Could not verify this address. Check the address and try again.', { code: 'not_found' });
  });
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const response = await admin.post('/api/v1/recipients').send({ name: 'Nowhere', ...VALID_ADDRESS });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'validation_failed');
  assert.match(response.body.error.details[0].message, /could not verify this address/i);

  const listed = await admin.get('/api/v1/recipients').expect(200);
  assert.equal(listed.body.length, 0, 'no recipient should have been created');
});

test('a partial address (missing a required field) is rejected before any geocode call', async () => {
  let called = false;
  setGeocodeImpl(async () => { called = true; return { latitude: 0, longitude: 0 }; });
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const response = await admin.post('/api/v1/recipients').send({ name: 'Partial', addressLine1: '123 Main St', city: 'Rochester' });
  assert.equal(response.status, 400);
  assert.ok(response.body.error.details.some((d) => d.path === 'state'));
  assert.ok(response.body.error.details.some((d) => d.path === 'postalCode'));
  assert.equal(called, false, 'geocoder must not be called for an incomplete address');
});

test('editing a recipient\'s address re-geocodes and updates the location atomically', async () => {
  setGeocodeImpl(async () => ({ latitude: 41.0645, longitude: -86.2183 }));
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const created = await admin.post('/api/v1/recipients').send({ name: 'Jamie Rivera', ...VALID_ADDRESS }).expect(201);

  setGeocodeImpl(async (address) => {
    assert.equal(address.city, 'Fort Wayne');
    return { latitude: 41.0793, longitude: -85.1394 };
  });
  const updated = await admin.patch(`/api/v1/recipients/${created.body.id}`).send({
    addressLine1: '456 Oak Ave', city: 'Fort Wayne', state: 'IN', postalCode: '46802',
  }).expect(200);
  assert.equal(updated.body.city, 'Fort Wayne');
  assert.equal(updated.body.longitude, -85.1394);
  assert.equal(updated.body.latitude, 41.0793);
});

test('a geocoder failure on edit leaves the existing recipient completely unchanged', async () => {
  setGeocodeImpl(async () => ({ latitude: 41.0645, longitude: -86.2183 }));
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const created = await admin.post('/api/v1/recipients').send({ name: 'Jamie Rivera', ...VALID_ADDRESS }).expect(201);

  setGeocodeImpl(async () => { throw new GeocodeError('Could not verify this address.', { code: 'not_found' }); });
  const failedUpdate = await admin.patch(`/api/v1/recipients/${created.body.id}`).send({
    addressLine1: 'Nonexistent Rd', city: 'Nowhere', state: 'ZZ', postalCode: '00000', name: 'Renamed Too',
  });
  assert.equal(failedUpdate.status, 400);

  const stillThere = await admin.get('/api/v1/recipients').expect(200);
  assert.equal(stillThere.body[0].name, 'Jamie Rivera', 'name must be unchanged -- the whole PATCH failed atomically');
  assert.equal(stillThere.body[0].addressLine1, '123 Main St');
  assert.equal(stillThere.body[0].city, 'Rochester');
  assert.equal(stillThere.body[0].longitude, -86.2183);
  assert.equal(stillThere.body[0].latitude, 41.0645);
});

test('explicit manual longitude/latitude always skips geocoding, even alongside an address', async () => {
  let called = false;
  setGeocodeImpl(async () => { called = true; throw new GeocodeError('should not be called', { code: 'not_found' }); });
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const created = await admin.post('/api/v1/recipients').send({
    name: 'Manual Override', ...VALID_ADDRESS, longitude: -86.7, latitude: 39.7,
  }).expect(201);
  assert.equal(called, false, 'the geocoder must not be called when coordinates are given explicitly');
  assert.equal(created.body.longitude, -86.7);
  assert.equal(created.body.latitude, 39.7);
  assert.equal(created.body.addressLine1, '123 Main St', 'the address is still stored for reference');
});

test('the disabled ("not configured") geocoder produces a clear validation error, not a crash', async () => {
  setGeocodeImpl(async () => { throw new GeocodeError('Address geocoding is not configured for this environment.', { code: 'not_configured' }); });
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const response = await admin.post('/api/v1/recipients').send({ name: 'No Geocoder', ...VALID_ADDRESS });
  assert.equal(response.status, 400);
  assert.match(response.body.error.details[0].message, /not configured/i);
});

test('address-bearing recipients remain tenant-isolated', async () => {
  setGeocodeImpl(async () => ({ latitude: 41.0645, longitude: -86.2183 }));
  const adminOfA = agentFor(adminA, tenantA, 'tenant_admin');
  const adminOfB = agentFor(adminB, tenantB, 'tenant_admin');

  const created = await adminOfA.post('/api/v1/recipients').send({ name: 'Only in A', ...VALID_ADDRESS }).expect(201);

  const listedByB = await adminOfB.get('/api/v1/recipients').expect(200);
  assert.equal(listedByB.body.length, 0);

  const updateFromB = await adminOfB.patch(`/api/v1/recipients/${created.body.id}`).send({
    addressLine1: 'Hijacked St', city: 'Hijacked', state: 'HI', postalCode: '00000',
  });
  assert.equal(updateFromB.status, 404);
});

// --- Clearing an address (regression coverage) -------------------------

test('explicitly clearing an address wipes address fields and derived location, without calling the geocoder', async () => {
  setGeocodeImpl(async () => ({ latitude: 41.0645, longitude: -86.2183 }));
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const created = await admin.post('/api/v1/recipients').send({ name: 'Jamie Rivera', ...VALID_ADDRESS }).expect(201);
  assert.equal(created.body.longitude, -86.2183);

  let geocodeCalledAfterCreate = false;
  setGeocodeImpl(async () => { geocodeCalledAfterCreate = true; return { latitude: 0, longitude: 0 }; });

  const cleared = await admin.patch(`/api/v1/recipients/${created.body.id}`).send({
    addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
  }).expect(200);

  assert.equal(geocodeCalledAfterCreate, false, 'the geocoder must not be called when clearing an address');
  assert.equal(cleared.body.addressLine1, null);
  assert.equal(cleared.body.city, null);
  assert.equal(cleared.body.state, null);
  assert.equal(cleared.body.postalCode, null);
  assert.equal(cleared.body.country, null);
  assert.equal(cleared.body.longitude, null, 'derived longitude must be cleared alongside the address');
  assert.equal(cleared.body.latitude, null, 'derived latitude must be cleared alongside the address');
  assert.equal(cleared.body.name, 'Jamie Rivera', 'unrelated fields must be preserved');

  const dbRow = await withSuperuserClient((client) => client.query(
    `SELECT address_line1, city, state, postal_code, country, location
     FROM recipients WHERE id = $1`, [created.body.id]
  ));
  assert.equal(dbRow.rows[0].address_line1, null);
  assert.equal(dbRow.rows[0].city, null);
  assert.equal(dbRow.rows[0].location, null);
});

test('a recipient whose address was cleared is no longer matched by polygon targeting', async () => {
  setGeocodeImpl(async () => ({ latitude: 39.7, longitude: -86.7 }));
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const created = await admin.post('/api/v1/recipients').send({ name: 'Jamie Rivera', ...VALID_ADDRESS }).expect(201);

  const polygonAroundJamie = {
    type: 'polygon',
    geojson: {
      type: 'Polygon',
      coordinates: [[[-87, 39.5], [-86, 39.5], [-86, 40], [-87, 40], [-87, 39.5]]],
    },
  };

  const beforeAlertId = await insertAlert(polygonAroundJamie);
  const beforeResult = await fanoutStore.materialize(fanoutEvent(beforeAlertId));
  assert.deepEqual(new Set(beforeResult.jobs.map((job) => job.recipientId)), new Set([created.body.id]),
    'sanity check: the recipient is matched by the polygon before clearing');

  await admin.patch(`/api/v1/recipients/${created.body.id}`).send({
    addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
  }).expect(200);

  const afterAlertId = await insertAlert(polygonAroundJamie);
  const afterResult = await fanoutStore.materialize(fanoutEvent(afterAlertId));
  assert.equal(afterResult.jobs.length, 0, 'a recipient with no location must not be matched by polygon targeting');
});

test('an unrelated edit preserves the existing address and location, without re-geocoding', async () => {
  setGeocodeImpl(async () => ({ latitude: 41.0645, longitude: -86.2183 }));
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const created = await admin.post('/api/v1/recipients').send({ name: 'Jamie Rivera', ...VALID_ADDRESS }).expect(201);

  let geocodeCalledAfterCreate = false;
  setGeocodeImpl(async () => { geocodeCalledAfterCreate = true; return { latitude: 0, longitude: 0 }; });

  const renamed = await admin.patch(`/api/v1/recipients/${created.body.id}`).send({ name: 'Jamie R. Rivera' }).expect(200);

  assert.equal(geocodeCalledAfterCreate, false, 'an edit that never touches the address must not re-geocode');
  assert.equal(renamed.body.name, 'Jamie R. Rivera');
  assert.equal(renamed.body.addressLine1, '123 Main St');
  assert.equal(renamed.body.city, 'Rochester');
  assert.equal(renamed.body.longitude, -86.2183);
  assert.equal(renamed.body.latitude, 41.0645);
});

test('a partially-entered address is rejected, not silently treated as a clear', async () => {
  setGeocodeImpl(async () => ({ latitude: 41.0645, longitude: -86.2183 }));
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const created = await admin.post('/api/v1/recipients').send({ name: 'Jamie Rivera', ...VALID_ADDRESS }).expect(201);

  const response = await admin.patch(`/api/v1/recipients/${created.body.id}`).send({ addressLine1: 'New St Only' });
  assert.equal(response.status, 400);
  assert.ok(response.body.error.details.some((d) => d.path === 'city'));
  assert.ok(response.body.error.details.some((d) => d.path === 'state'));
  assert.ok(response.body.error.details.some((d) => d.path === 'postalCode'));

  const unchanged = await admin.get('/api/v1/recipients').expect(200);
  assert.equal(unchanged.body[0].addressLine1, '123 Main St', 'the original address must be untouched by the rejected PATCH');
});

test('changing from one non-empty address to another still re-geocodes', async () => {
  setGeocodeImpl(async () => ({ latitude: 41.0645, longitude: -86.2183 }));
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const created = await admin.post('/api/v1/recipients').send({ name: 'Jamie Rivera', ...VALID_ADDRESS }).expect(201);

  setGeocodeImpl(async (address) => {
    assert.equal(address.city, 'Fort Wayne');
    return { latitude: 41.0793, longitude: -85.1394 };
  });
  const updated = await admin.patch(`/api/v1/recipients/${created.body.id}`).send({
    addressLine1: '456 Oak Ave', city: 'Fort Wayne', state: 'IN', postalCode: '46802',
  }).expect(200);
  assert.equal(updated.body.city, 'Fort Wayne');
  assert.equal(updated.body.longitude, -85.1394);
  assert.equal(updated.body.latitude, 41.0793);
});
