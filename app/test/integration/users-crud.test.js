'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const request = require('supertest');
const { ensureMigrated, withSuperuserClient } = require('./support/db');
const { createIntakeFixture } = require('./support/intake');
const { authenticateDemoUser } = require('../../src/intake/login');
const { createDb, createPool } = require('../../src/shared/db');
const { loadConfig } = require('../../src/shared/config');

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
       VALUES ($1, 'Tenant A', 'users-tenant-a', 'county_em'),
              ($2, 'Tenant B', 'users-tenant-b', 'school_district')`,
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

function agentFor(userId, tenantId, role) {
  const token = fixture.sign({ tenantId, userId, role });
  return {
    get: (path) => request(fixture.app).get(path).set('Authorization', `Bearer ${token}`),
    post: (path) => request(fixture.app).post(path).set('Authorization', `Bearer ${token}`),
  };
}

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture();
});
beforeEach(clearRows);
after(async () => fixture?.pool.end());

test('tenant_admin can list and create additional tenant users, who can immediately log in with the chosen role', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const initialList = await admin.get('/api/v1/users').expect(200);
  assert.equal(initialList.body.length, 2); // adminA + operatorA seeded above
  assert.ok(initialList.body.every((user) => !('password' in user) && !('passwordHash' in user)));

  const created = await admin.post('/api/v1/users').send({
    email: 'new-operator@example.test', password: 'demo-only-change-me', role: 'operator',
  }).expect(201);
  assert.equal(created.body.email, 'new-operator@example.test');
  assert.equal(created.body.role, 'operator');

  const listed = await admin.get('/api/v1/users').expect(200);
  assert.equal(listed.body.length, 3);

  const db = createDb(createPool(loadConfig().appDatabaseUrl));
  try {
    const login = await authenticateDemoUser({
      db, jwtSecret: 'test-secret', email: 'new-operator@example.test', password: 'demo-only-change-me',
    });
    assert.equal(login.role, 'operator');
  } finally {
    await db.pool.end();
  }
});

test('creating a user with an already-used email in the same tenant is a clean 409, not a raw constraint error', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const response = await admin.post('/api/v1/users').send({
    email: 'admin-a@example.test', password: 'demo-only-change-me', role: 'operator',
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'email_taken');
});

test('operators cannot list or create users; tenant admins cannot see or create users for another tenant', async () => {
  const operator = agentFor(operatorA, tenantA, 'operator');
  const forbiddenList = await operator.get('/api/v1/users');
  assert.equal(forbiddenList.status, 403);
  const forbiddenCreate = await operator.post('/api/v1/users').send({ email: 'x@example.test', password: 'demo-only-change-me', role: 'operator' });
  assert.equal(forbiddenCreate.status, 403);

  const adminOfB = agentFor(adminB, tenantB, 'tenant_admin');
  const listedByB = await adminOfB.get('/api/v1/users').expect(200);
  assert.equal(listedByB.body.length, 1, 'tenant B must only see its own single seeded admin, never tenant A\'s users');
  assert.ok(listedByB.body.every((user) => user.email !== 'admin-a@example.test' && user.email !== 'operator-a@example.test'));
});

test('an invalid role is rejected by validation, not silently coerced', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const response = await admin.post('/api/v1/users').send({
    email: 'bad-role@example.test', password: 'demo-only-change-me', role: 'platform_admin',
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'validation_failed');
});
