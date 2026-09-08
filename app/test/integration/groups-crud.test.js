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
let recipientA;
let recipientB;

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
       VALUES ($1, 'Tenant A', 'groups-tenant-a', 'county_em'),
              ($2, 'Tenant B', 'groups-tenant-b', 'school_district')`,
      [tenantA, tenantB]
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, 'admin-a@example.test', 'x', 'tenant_admin'),
              ($3, $2, 'operator-a@example.test', 'x', 'operator'),
              ($4, $5, 'admin-b@example.test', 'x', 'tenant_admin')`,
      [adminA, tenantA, operatorA, adminB, tenantB]
    );
    recipientA = randomUUID();
    recipientB = randomUUID();
    await client.query(
      `INSERT INTO recipients (id, tenant_id, name) VALUES ($1, $2, 'Recipient A'), ($3, $4, 'Recipient B')`,
      [recipientA, tenantA, recipientB, tenantB]
    );
  });
}

function agentFor(userId, tenantId, role) {
  const token = fixture.sign({ tenantId, userId, role });
  return {
    get: (path) => request(fixture.app).get(path).set('Authorization', `Bearer ${token}`),
    post: (path) => request(fixture.app).post(path).set('Authorization', `Bearer ${token}`),
    patch: (path) => request(fixture.app).patch(path).set('Authorization', `Bearer ${token}`),
    delete: (path) => request(fixture.app).delete(path).set('Authorization', `Bearer ${token}`),
  };
}

before(async () => {
  await ensureMigrated();
  fixture = createIntakeFixture();
});
beforeEach(clearRows);
after(async () => fixture?.pool.end());

test('tenant_admin can create, rename, add/remove members, and delete a group without deleting recipients', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');

  const created = await admin.post('/api/v1/groups').send({ name: 'Field Team' }).expect(201);
  assert.equal(created.body.name, 'Field Team');
  assert.equal(created.body.memberCount, 0);
  const groupId = created.body.id;

  const renamed = await admin.patch(`/api/v1/groups/${groupId}`).send({ name: 'Field Team East' }).expect(200);
  assert.equal(renamed.body.name, 'Field Team East');

  const emptyMembers = await admin.get(`/api/v1/groups/${groupId}/members`).expect(200);
  assert.deepEqual(emptyMembers.body.members, []);

  const added = await admin.post(`/api/v1/groups/${groupId}/members`).send({ recipientId: recipientA }).expect(201);
  assert.deepEqual(added.body, { groupId, recipientId: recipientA });

  // Adding the same member twice is idempotent, not an error or a duplicate row.
  await admin.post(`/api/v1/groups/${groupId}/members`).send({ recipientId: recipientA }).expect(201);

  const withMember = await admin.get(`/api/v1/groups/${groupId}/members`).expect(200);
  assert.equal(withMember.body.members.length, 1);
  assert.equal(withMember.body.members[0].name, 'Recipient A');

  const listed = await admin.get('/api/v1/groups').expect(200);
  assert.equal(listed.body.find((g) => g.id === groupId).memberCount, 1);

  await admin.delete(`/api/v1/groups/${groupId}/members/${recipientA}`).expect(204);
  const afterRemove = await admin.get(`/api/v1/groups/${groupId}/members`).expect(200);
  assert.deepEqual(afterRemove.body.members, []);

  await admin.post(`/api/v1/groups/${groupId}/members`).send({ recipientId: recipientA }).expect(201);
  await admin.delete(`/api/v1/groups/${groupId}`).expect(204);

  const membershipRows = await withSuperuserClient((client) => client.query(
    'SELECT count(*)::int c FROM group_members WHERE group_id = $1', [groupId]
  ));
  assert.equal(membershipRows.rows[0].c, 0, 'deleting a group must remove its memberships');

  const recipientStillExists = await withSuperuserClient((client) => client.query(
    'SELECT name FROM recipients WHERE id = $1', [recipientA]
  ));
  assert.equal(recipientStillExists.rows[0].name, 'Recipient A', 'deleting a group must never delete recipients');
});

test('adding a member requires both the group and the recipient to belong to the caller\'s own tenant', async () => {
  const adminOfA = agentFor(adminA, tenantA, 'tenant_admin');
  const group = await adminOfA.post('/api/v1/groups').send({ name: 'A Team' }).expect(201);

  const crossTenantRecipient = await adminOfA.post(`/api/v1/groups/${group.body.id}/members`).send({ recipientId: recipientB });
  assert.equal(crossTenantRecipient.status, 404, 'a recipient belonging to another tenant must not be addable, even to this tenant\'s own group');

  const membershipRows = await withSuperuserClient((client) => client.query(
    'SELECT count(*)::int c FROM group_members WHERE recipient_id = $1', [recipientB]
  ));
  assert.equal(membershipRows.rows[0].c, 0, 'no cross-tenant membership row must have been created');
});

test('operators can read groups and membership but cannot mutate either', async () => {
  const admin = agentFor(adminA, tenantA, 'tenant_admin');
  const operator = agentFor(operatorA, tenantA, 'operator');
  const group = await admin.post('/api/v1/groups').send({ name: 'Readable Group' }).expect(201);

  await operator.get('/api/v1/groups').expect(200);
  await operator.get(`/api/v1/groups/${group.body.id}/members`).expect(200);

  for (const attempt of [
    () => operator.post('/api/v1/groups').send({ name: 'Blocked' }),
    () => operator.patch(`/api/v1/groups/${group.body.id}`).send({ name: 'Blocked' }),
    () => operator.post(`/api/v1/groups/${group.body.id}/members`).send({ recipientId: recipientA }),
    () => operator.delete(`/api/v1/groups/${group.body.id}/members/${recipientA}`),
    () => operator.delete(`/api/v1/groups/${group.body.id}`),
  ]) {
    const response = await attempt();
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'forbidden');
  }
});

test('a tenant cannot rename, delete, or view membership of another tenant\'s group (404, not 403)', async () => {
  const adminOfA = agentFor(adminA, tenantA, 'tenant_admin');
  const adminOfB = agentFor(adminB, tenantB, 'tenant_admin');
  const group = await adminOfA.post('/api/v1/groups').send({ name: 'A Only' }).expect(201);

  const renameFromB = await adminOfB.patch(`/api/v1/groups/${group.body.id}`).send({ name: 'Hijacked' });
  assert.equal(renameFromB.status, 404);

  const membersFromB = await adminOfB.get(`/api/v1/groups/${group.body.id}/members`);
  assert.equal(membersFromB.status, 404);

  const deleteFromB = await adminOfB.delete(`/api/v1/groups/${group.body.id}`);
  assert.equal(deleteFromB.status, 404);

  const stillThere = await adminOfA.get('/api/v1/groups').expect(200);
  assert.equal(stillThere.body.find((g) => g.name === 'A Only').id, group.body.id);
});
