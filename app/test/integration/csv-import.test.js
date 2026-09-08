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
let groupA; // "Field Team" in tenant A
let groupB; // "Field Team" in tenant B -- same name, different tenant, must never cross-match

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
       VALUES ($1, 'Tenant A', 'csv-tenant-a', 'county_em'),
              ($2, 'Tenant B', 'csv-tenant-b', 'school_district')`,
      [tenantA, tenantB]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, 'admin-a@example.test', 'x', 'tenant_admin'),
              ($3, $2, 'operator-a@example.test', 'x', 'operator'),
              ($4, $5, 'admin-b@example.test', 'x', 'tenant_admin')`,
      [adminA, tenantA, operatorA, adminB, tenantB]
    );
    groupA = randomUUID();
    groupB = randomUUID();
    await client.query(
      `INSERT INTO groups (id, tenant_id, name) VALUES ($1, $2, 'Field Team'), ($3, $4, 'Field Team')`,
      [groupA, tenantA, groupB, tenantB]
    );
  });
}

function agentFor(userId, tenantId, role) {
  const token = fixture.sign({ tenantId, userId, role });
  return {
    post: (path) => request(fixture.app).post(path).set('Authorization', `Bearer ${token}`),
  };
}

async function membersOf(groupId) {
  return withSuperuserClient(async (client) => {
    const { rows } = await client.query(
      `SELECT r.name FROM group_members gm JOIN recipients r ON r.id = gm.recipient_id
       WHERE gm.group_id = $1 ORDER BY r.name`,
      [groupId]
    );
    return rows.map((row) => row.name);
  });
}

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture();
});
beforeEach(clearRows);
after(async () => fixture?.pool.end());

test('imports valid rows, honors a known group, leaves a blank group unassigned, and reports the summary', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const csv = [
    'name,email,phone,latitude,longitude,group',
    'Jamie Rivera,jamie@example.test,+15551234567,39.7,-86.7,Field Team',
    'Alex Chen,alex@example.test,,,,',
  ].join('\n');

  const response = await admin.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.deepEqual(response.body, { imported: 2, skipped: 0, failed: 0, errors: [] });

  assert.deepEqual(await membersOf(groupA), ['Jamie Rivera']);

  const recipients = await withSuperuserClient((client) => client.query(
    'SELECT name, email, ST_X(location::geometry) lon FROM recipients WHERE tenant_id = $1 ORDER BY name', [tenantA]
  ));
  assert.equal(recipients.rows.length, 2);
  assert.equal(recipients.rows.find((r) => r.name === 'Jamie Rivera').lon, -86.7);
  assert.equal(recipients.rows.find((r) => r.name === 'Alex Chen').lon, null);
});

test('an unknown group name rejects that row with a clear error and does not create a group', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const csv = [
    'name,group',
    'Taylor Kim,Nonexistent Squad',
  ].join('\n');

  const response = await admin.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.deepEqual(response.body.errors, [{ row: 2, message: "Unknown group: 'Nonexistent Squad'" }]);
  assert.equal(response.body.imported, 0);
  assert.equal(response.body.failed, 1);

  const groups = await withSuperuserClient((client) => client.query(
    'SELECT count(*)::int c FROM groups WHERE tenant_id = $1', [tenantA]
  ));
  assert.equal(groups.rows[0].c, 1, 'only the pre-existing "Field Team" group should exist -- no group was auto-created');

  const recipients = await withSuperuserClient((client) => client.query(
    'SELECT count(*)::int c FROM recipients WHERE tenant_id = $1', [tenantA]
  ));
  assert.equal(recipients.rows[0].c, 0, 'the rejected row must not have been imported without its group');
});

test('mixed valid and invalid rows: malformed coordinates and missing name fail individually without aborting the batch', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const csv = [
    'name,email,latitude,longitude',
    'Good Row,good@example.test,39.7,-86.7',
    ',missing-name@example.test,,',
    'Bad Coords,bad@example.test,not-a-number,-86.7',
    'Only Latitude,onlylat@example.test,39.7,',
    'Out Of Range,outofrange@example.test,95,-86.7',
  ].join('\n');

  const response = await admin.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.equal(response.body.imported, 1);
  assert.equal(response.body.failed, 4);
  assert.equal(response.body.skipped, 0);
  assert.deepEqual(response.body.errors.map((e) => e.row), [3, 4, 5, 6]);
  assert.match(response.body.errors[0].message, /name is required/);
  assert.match(response.body.errors[1].message, /not a valid number/);
  assert.match(response.body.errors[2].message, /must be provided together/);
  assert.match(response.body.errors[3].message, /out of range/);

  const names = await withSuperuserClient((client) => client.query(
    'SELECT name FROM recipients WHERE tenant_id = $1', [tenantA]
  ));
  assert.deepEqual(names.rows.map((r) => r.name), ['Good Row']);
});

test('duplicate emails (against an existing recipient, and within the same file) are skipped, not re-imported', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  await admin.post('/api/v1/recipients').send({ name: 'Existing Person', email: 'dup@example.test' }).expect(201);

  const csv = [
    'name,email',
    'Duplicate Of Existing,dup@example.test',
    'Fresh Person,fresh@example.test',
    'Duplicate Within File,fresh@example.test',
  ].join('\n');

  const response = await admin.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.equal(response.body.imported, 1);
  assert.equal(response.body.skipped, 2);
  assert.equal(response.body.failed, 0);

  const count = await withSuperuserClient((client) => client.query(
    "SELECT count(*)::int c FROM recipients WHERE tenant_id = $1 AND email = 'fresh@example.test'", [tenantA]
  ));
  assert.equal(count.rows[0].c, 1);
});

test('a group name only matches within the importing tenant -- no cross-tenant membership creation', async () => {
  const adminOfA = agentFor(adminA, tenantA, 'tenant_admin');
  const csv = ['name,group', 'Cross Tenant Check,Field Team'].join('\n');

  const response = await adminOfA.post('/api/v1/recipients/import').send({ csv }).expect(200);
  assert.equal(response.body.imported, 1);
  assert.deepEqual(await membersOf(groupA), ['Cross Tenant Check']);
  assert.deepEqual(await membersOf(groupB), [], 'tenant B\'s identically-named group must not receive a member from tenant A\'s import');
});

test('operator cannot import; unknown columns and a missing name column reject the whole file upfront', async () => {
  const operator = agentFor(operatorA, tenantA, 'operator');
  const forbidden = await operator.post('/api/v1/recipients/import').send({ csv: 'name\nAnyone' });
  assert.equal(forbidden.status, 403);

  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const unknownColumn = await admin.post('/api/v1/recipients/import').send({ csv: 'name,favorite_color\nA,Blue' });
  assert.equal(unknownColumn.status, 400);

  const missingName = await admin.post('/api/v1/recipients/import').send({ csv: 'email\na@example.test' });
  assert.equal(missingName.status, 400);
});

test('a CSV exceeding the row limit is rejected upfront', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const rows = Array.from({ length: 1_001 }, (_, i) => `Person ${i}`).join('\n');
  const response = await admin.post('/api/v1/recipients/import').send({ csv: `name\n${rows}` });
  assert.equal(response.status, 400);
  assert.match(response.body.error.details?.[0]?.message ?? '', /at most 1000 data rows/);
});

test('exported CSV round-trips the tenant\'s own active recipients', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  await admin.post('/api/v1/recipients').send({ name: 'Export Me', email: 'export@example.test', longitude: -86.7, latitude: 39.7 }).expect(201);

  const response = await request(fixture.app)
    .get('/api/v1/recipients/export')
    .set('Authorization', `Bearer ${fixture.sign({ tenantId: tenantA, userId: adminA, role: 'tenant_admin' })}`)
    .expect(200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(response.text, /^name,email,phone,address_line1,address_line2,city,state,postal_code,country,latitude,longitude/);
  assert.match(response.text, /Export Me,export@example\.test,,,,,,,,39\.7,-86\.7/);
});
