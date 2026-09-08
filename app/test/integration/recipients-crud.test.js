'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const request = require('supertest');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const { createIntakeFixture } = require('./support/intake');

const tenantA = randomUUID();
const tenantB = randomUUID();
const adminA = randomUUID();
const operatorA = randomUUID();
const adminB = randomUUID();
let fixture;

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
       VALUES ($1, 'Tenant A', 'recipients-tenant-a', 'county_em'),
              ($2, 'Tenant B', 'recipients-tenant-b', 'school_district')`,
      [tenantA, tenantB]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, 'admin-a@example.test', 'x', 'tenant_admin'),
              ($3, $2, 'operator-a@example.test', 'x', 'operator'),
              ($4, $5, 'admin-b@example.test', 'x', 'tenant_admin')`,
      [adminA, tenantA, operatorA, adminB, tenantB]
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
    delete: (path) => request(fixture.app).delete(path).set('Authorization', `Bearer ${as(userId, tenantId, role)}`),
  };
}

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture();
});
beforeEach(clearRows);
after(async () => fixture?.pool.end());

test('tenant_admin can create, list, update, and soft-delete a recipient; operator is forbidden', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const operator = agentFor(operatorA, tenantA, 'operator');

  for (const [method, path] of [['get', '/api/v1/recipients'], ['post', '/api/v1/recipients']]) {
    const response = await operator[method](path).send({ name: 'Blocked' });
    assert.equal(response.status, 403, `${method.toUpperCase()} ${path} must be forbidden for an operator`);
    assert.equal(response.body.error.code, 'forbidden');
  }

  const created = await admin.post('/api/v1/recipients').send({
    name: 'Jamie Rivera', phone: '+15551234567', email: 'jamie@example.test',
    longitude: -86.7, latitude: 39.7,
  }).expect(201);
  assert.equal(created.body.name, 'Jamie Rivera');
  assert.equal(created.body.active, true);
  assert.equal(created.body.longitude, -86.7);
  assert.equal(created.body.latitude, 39.7);

  const listed = await admin.get('/api/v1/recipients').expect(200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, created.body.id);

  const updated = await admin.patch(`/api/v1/recipients/${created.body.id}`).send({ phone: null, name: 'Jamie R.' }).expect(200);
  assert.equal(updated.body.name, 'Jamie R.');
  assert.equal(updated.body.phone, null);
  assert.equal(updated.body.email, 'jamie@example.test', 'fields not included in the PATCH body must be left unchanged');

  // Regression: the frontend's edit form always submits the full recipient
  // shape, so name/phone/email are commonly PATCHed together with
  // longitude/latitude in the same request -- buildUpdateSet's SQL
  // placeholder numbering must stay correct when both groups are present,
  // not just when longitude/latitude are updated alone.
  const updatedWithCoords = await admin.patch(`/api/v1/recipients/${created.body.id}`).send({
    name: 'Jamie R. Rivera', phone: null, email: 'jamie@example.test', longitude: -87.5, latitude: 40.1,
  }).expect(200);
  assert.equal(updatedWithCoords.body.name, 'Jamie R. Rivera');
  assert.equal(updatedWithCoords.body.longitude, -87.5);
  assert.equal(updatedWithCoords.body.latitude, 40.1);

  const deactivated = await admin.delete(`/api/v1/recipients/${created.body.id}`).expect(200);
  assert.equal(deactivated.body.active, false);

  const listAfterDeactivate = await admin.get('/api/v1/recipients').expect(200);
  assert.equal(listAfterDeactivate.body.length, 0, 'deactivated recipients are excluded from the default list');
  const listIncludingInactive = await admin.get('/api/v1/recipients?includeInactive=true').expect(200);
  assert.equal(listIncludingInactive.body.length, 1);
});

test('name is required; phone and email are each independently optional', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const missingName = await admin.post('/api/v1/recipients').send({ phone: '+15551234567' });
  assert.equal(missingName.status, 400);
  assert.equal(missingName.body.error.code, 'validation_failed');

  const phoneOnly = await admin.post('/api/v1/recipients').send({ name: 'Phone Only', phone: '+15551234567' }).expect(201);
  assert.equal(phoneOnly.body.email, null);

  const emailOnly = await admin.post('/api/v1/recipients').send({ name: 'Email Only', email: 'only@example.test' }).expect(201);
  assert.equal(emailOnly.body.phone, null);

  const neither = await admin.post('/api/v1/recipients').send({ name: 'Neither' }).expect(201);
  assert.equal(neither.body.phone, null);
  assert.equal(neither.body.email, null);
});

test('coordinates are optional but must be provided together and within bounds', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const noCoords = await admin.post('/api/v1/recipients').send({ name: 'No Location' }).expect(201);
  assert.equal(noCoords.body.longitude, null);
  assert.equal(noCoords.body.latitude, null);

  const lonOnly = await admin.post('/api/v1/recipients').send({ name: 'Bad', longitude: -86.7 });
  assert.equal(lonOnly.status, 400);

  const latOnly = await admin.post('/api/v1/recipients').send({ name: 'Bad', latitude: 39.7 });
  assert.equal(latOnly.status, 400);

  for (const [longitude, latitude] of [[-181, 0], [181, 0], [0, -91], [0, 91]]) {
    const response = await admin.post('/api/v1/recipients').send({ name: 'Out of bounds', longitude, latitude });
    assert.equal(response.status, 400, `(${longitude}, ${latitude}) must be rejected`);
  }

  const validEdge = await admin.post('/api/v1/recipients').send({ name: 'Edge', longitude: -180, latitude: 90 }).expect(201);
  assert.equal(validEdge.body.longitude, -180);
  assert.equal(validEdge.body.latitude, 90);
});

test('recipients are tenant-isolated: tenant B cannot see, update, or delete tenant A\'s recipients (404, not 403)', async () => {
  const adminOfA = agentFor(adminA, tenantA, 'tenant_admin');
  const adminOfB = agentFor(adminB, tenantB, 'tenant_admin');

  const created = await adminOfA.post('/api/v1/recipients').send({ name: 'Only in A' }).expect(201);

  const listedByB = await adminOfB.get('/api/v1/recipients').expect(200);
  assert.equal(listedByB.body.length, 0);

  const updateFromB = await adminOfB.patch(`/api/v1/recipients/${created.body.id}`).send({ name: 'Hijacked' });
  assert.equal(updateFromB.status, 404);

  const deleteFromB = await adminOfB.delete(`/api/v1/recipients/${created.body.id}`);
  assert.equal(deleteFromB.status, 404);

  const stillThere = await adminOfA.get('/api/v1/recipients').expect(200);
  assert.equal(stillThere.body[0].name, 'Only in A');
});
