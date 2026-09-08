'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const { createIntakeFixture } = require('./support/intake');
const { GeocodeError } = require('../../src/intake/geocoder');
const request = require('supertest');

const tenantA = randomUUID();
const adminA = randomUUID();
let fixture;

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
      `INSERT INTO tenants (id, name, slug, tenant_type) VALUES ($1, 'Tenant A', 'csv-address-tenant-a', 'county_em')`,
      [tenantA]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES ($1, $2, 'admin-a@example.test', 'x', 'tenant_admin')`,
      [adminA, tenantA]
    );
  });
}

function agentFor(userId, tenantId, role) {
  const token = fixture.sign({ tenantId, userId, role });
  return { post: (path) => request(fixture.app).post(path).set('Authorization', `Bearer ${token}`) };
}

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture({ geocode: controllableGeocode });
});
beforeEach(() => {
  setGeocodeImpl(async () => { throw new GeocodeError('no impl set for this test', { code: 'not_configured' }); });
  return clearRows();
});
after(async () => fixture?.pool.end());

test('address columns are geocoded per row and stored as the derived location', async () => {
  setGeocodeImpl(async (address) => {
    if (address.city === 'Rochester') return { latitude: 41.0645, longitude: -86.2183 };
    if (address.city === 'Fort Wayne') return { latitude: 41.0793, longitude: -85.1394 };
    throw new Error(`unexpected address in test: ${JSON.stringify(address)}`);
  });
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const csv = [
    'name,email,address_line1,city,state,postal_code',
    'Jamie Rivera,jamie@example.test,123 Main St,Rochester,IN,46975',
    'Alex Chen,alex@example.test,456 Oak Ave,Fort Wayne,IN,46802',
  ].join('\n');

  const response = await admin.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.deepEqual(response.body, { imported: 2, skipped: 0, failed: 0, errors: [] });

  const rows = await withSuperuserClient((client) => client.query(
    `SELECT name, city, ST_X(location::geometry) lon, ST_Y(location::geometry) lat
     FROM recipients WHERE tenant_id = $1 ORDER BY name`, [tenantA]
  ));
  assert.equal(rows.rows.length, 2);
  const jamie = rows.rows.find((r) => r.name === 'Jamie Rivera');
  assert.equal(jamie.city, 'Rochester');
  assert.equal(jamie.lon, -86.2183);
  assert.equal(jamie.lat, 41.0645);
});

test('a mixed batch: a geocoding failure fails only its own row, without aborting the rest of the import', async () => {
  setGeocodeImpl(async (address) => {
    if (address.city === 'Nowhereville') {
      throw new GeocodeError('Could not verify this address. Check the address and try again.', { code: 'not_found' });
    }
    return { latitude: 41.0645, longitude: -86.2183 };
  });
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const csv = [
    'name,email,address_line1,city,state,postal_code',
    'Good Address,good@example.test,123 Main St,Rochester,IN,46975',
    'Bad Address,bad@example.test,1 Nowhere Rd,Nowhereville,ZZ,00000',
    'Another Good One,good2@example.test,789 Pine St,Rochester,IN,46975',
  ].join('\n');

  const response = await admin.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.equal(response.body.imported, 2);
  assert.equal(response.body.failed, 1);
  assert.equal(response.body.errors.length, 1);
  assert.equal(response.body.errors[0].row, 3);
  assert.match(response.body.errors[0].message, /could not verify this address/i);

  const rows = await withSuperuserClient((client) => client.query(
    'SELECT name FROM recipients WHERE tenant_id = $1 ORDER BY name', [tenantA]
  ));
  assert.deepEqual(rows.rows.map((r) => r.name), ['Another Good One', 'Good Address']);
});

test('a row with coordinates given directly skips geocoding, even in an address-heavy import', async () => {
  let geocodeCalls = 0;
  setGeocodeImpl(async () => { geocodeCalls += 1; return { latitude: 0, longitude: 0 }; });
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const csv = [
    'name,email,latitude,longitude',
    'Manual Coords,manual@example.test,39.7,-86.7',
  ].join('\n');

  const response = await admin.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.deepEqual(response.body, { imported: 1, skipped: 0, failed: 0, errors: [] });
  assert.equal(geocodeCalls, 0, 'the geocoder must not be called when coordinates are given directly');
});

test('a partial address in a CSV row fails just that row with a clear message', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const csv = [
    'name,email,address_line1,city',
    'Partial,partial@example.test,123 Main St,Rochester',
  ].join('\n');

  const response = await admin.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.deepEqual(response.body.errors[0].row, 2);
  assert.match(response.body.errors[0].message, /state is required when providing an address/);
  assert.match(response.body.errors[0].message, /postal_code is required when providing an address/);
});
