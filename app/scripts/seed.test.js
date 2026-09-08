'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSeedPlan, seedDatabase } = require('./seed');

test('buildSeedPlan is deterministic and contains two tenants with demo audiences', () => {
  const first = buildSeedPlan({ demoUserPassword: 'configured-password' });
  const second = buildSeedPlan({ demoUserPassword: 'configured-password' });
  assert.deepEqual(first, second);
  assert.equal(first.tenants.length, 2);
  assert.equal(first.platformAdmins.length, 1);
  assert.equal(first.users.length, 4);
  assert.equal(first.groups.length, 6);
  assert.equal(first.recipients.length, 165);
  assert.equal(first.memberships.length, 165);
  assert.ok(first.users.every((user) => user.passwordHash.startsWith('scrypt$')));
  assert.ok(first.platformAdmins.every((admin) => admin.passwordHash.startsWith('scrypt$')));
  assert.deepEqual(first.users.map((user) => user.role).sort(), ['operator', 'operator', 'tenant_admin', 'tenant_admin']);
  assert.equal(
    new Set(first.users.map((user) => user.email.toLowerCase())).size,
    first.users.length,
    'seeded tenant-user emails must be globally unique, including case variants'
  );
  for (const tenant of first.tenants) {
    const tenantUsers = first.users.filter((user) => user.tenantId === tenant.id);
    assert.deepEqual(tenantUsers.map((user) => user.role).sort(), ['operator', 'tenant_admin']);
  }
  assert.ok(first.recipients.every((recipient) => Number.isFinite(recipient.longitude) && Number.isFinite(recipient.latitude)));
  const county = first.tenants.find((tenant) => tenant.slug === 'demo-county');
  const school = first.tenants.find((tenant) => tenant.slug === 'demo-school');
  const role = (name) => first.recipients.find((recipient) => recipient.geographicRole === name);
  assert.equal(role('inside-a').tenantId, county.id);
  assert.equal(role('inside-b').tenantId, county.id);
  assert.equal(role('outside').tenantId, county.id);
  assert.equal(role('boundary').tenantId, county.id);
  assert.deepEqual([role('boundary').longitude, role('boundary').latitude], [-86.73, 39.70]);

  const schoolRecipients = first.recipients.filter((recipient) => recipient.tenantId === school.id);
  assert.equal(schoolRecipients.length, 150);
  // The whole demo-school grid must stay on land, west of the Lake Michigan
  // shoreline (~-87.8 at this latitude) and south of the Wisconsin state
  // line (42.5) — see scripts/seed.js's comment on this loop.
  schoolRecipients.forEach((recipient) => {
    assert.ok(recipient.longitude <= -87.9, `expected ${recipient.name} west of the lake shore, got longitude ${recipient.longitude}`);
    assert.ok(recipient.latitude < 42.5, `expected ${recipient.name} south of the Wisconsin state line, got latitude ${recipient.latitude}`);
  });
});

test('seedDatabase performs a transaction and resets only fixed demo tenants', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const plan = buildSeedPlan();
  await seedDatabase({ client, plan });
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.ok(calls.some((call) => call.sql.includes('DELETE FROM deliveries')));
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO recipients')));
  assert.ok(calls.some((call) => call.sql.includes('ST_SetSRID(ST_MakePoint')));
  assert.ok(calls.some((call) => call.sql.includes('DELETE FROM platform_admins')));
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO platform_admins')));
});
