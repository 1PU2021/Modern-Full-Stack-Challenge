'use strict';

const crypto = require('node:crypto');
const { Client } = require('pg');
const { loadConfig } = require('../src/shared/config');
const { hashDemoPassword } = require('../src/shared/demo-auth');

const TENANTS = [
  { slug: 'demo-county', name: 'Demo County Emergency Management', tenantType: 'county_em' },
  { slug: 'demo-school', name: 'Demo School District', tenantType: 'school_district' },
];

function stableUuid(key) {
  const bytes = crypto.createHash('sha256').update(`critical-demo:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Curated so the "County-wide alerts" cluster is visible and drawable on a
// map centered near web/src/demo-geography.js's DEMO_MAP_VIEW/DEMO_POLYGON.
// Marker coordinates shown to the operator in the frontend must stay in sync
// with these values (see web/src/demo-geography.js
// DEMO_RECIPIENTS_BY_TENANT['demo-county']).
const COUNTY_RECIPIENTS = [
  { key: 'boundary', name: 'Demo County Recipient (boundary)', longitude: -86.73, latitude: 39.70, phone: true, email: true, geographicRole: 'boundary' },
  { key: 'inside-a', name: 'Demo County Recipient (inside-a)', longitude: -86.70, latitude: 39.70, phone: true, email: true, geographicRole: 'inside-a' },
  { key: 'inside-b', name: 'Demo County Recipient (inside-b)', longitude: -86.66, latitude: 39.72, phone: true, email: true, geographicRole: 'inside-b' },
  { key: 'outside', name: 'Demo County Recipient (outside)', longitude: -87.10, latitude: 40.10, phone: true, email: true, geographicRole: 'outside' },
  { key: 'hendricks-ave', name: 'Hendricks Ave', longitude: -86.715, latitude: 39.705, phone: true, email: true },
  { key: 'oak-street', name: 'Oak Street', longitude: -86.685, latitude: 39.735, phone: true, email: false },
  { key: 'maple-ridge', name: 'Maple Ridge', longitude: -86.645, latitude: 39.715, phone: false, email: true },
  { key: 'fairview-lane', name: 'Fairview Lane', longitude: -86.72, latitude: 39.68, phone: true, email: true },
  { key: 'elm-corner', name: 'Elm Corner', longitude: -86.665, latitude: 39.695, phone: true, email: false },
  { key: 'spruce-field', name: 'Spruce Field', longitude: -86.705, latitude: 39.725, phone: true, email: true },
  { key: 'willow-court', name: 'Willow Court', longitude: -86.675, latitude: 39.745, phone: false, email: true },
  { key: 'birch-hollow', name: 'Birch Hollow', longitude: -86.695, latitude: 39.665, phone: false, email: true },
  { key: 'cedar-bend', name: 'Cedar Bend', longitude: -86.755, latitude: 39.71, phone: true, email: false },
  { key: 'pinehurst', name: 'Pinehurst', longitude: -86.68, latitude: 39.78, phone: true, email: true },
  { key: 'sugar-creek', name: 'Sugar Creek', longitude: -86.6, latitude: 39.72, phone: true, email: false },
];

function buildSeedPlan({ demoUserPassword = 'demo-only-change-me' } = {}) {
  const tenants = TENANTS.map((tenant) => ({ ...tenant, id: stableUuid(`tenant:${tenant.slug}`) }));
  const platformAdmins = [{
    id: stableUuid('platform-admin:critical-demo'),
    email: 'platform-admin@critical-demo.test',
    passwordHash: hashDemoPassword(demoUserPassword, 'critical-demo-platform-admin'),
  }];
  const users = tenants.flatMap((tenant) => [
    {
      id: stableUuid(`user:${tenant.slug}:admin`), tenantId: tenant.id, email: `admin@${tenant.slug}.test`,
      role: 'tenant_admin', passwordHash: hashDemoPassword(demoUserPassword, `critical-demo-${tenant.slug}-admin`),
    },
    {
      id: stableUuid(`user:${tenant.slug}:operator`), tenantId: tenant.id, email: `operator@${tenant.slug}.test`,
      role: 'operator', passwordHash: hashDemoPassword(demoUserPassword, `critical-demo-${tenant.slug}-operator`),
    },
  ]);
  const groups = tenants.flatMap((tenant) => ['County-wide alerts', 'Targeted response team', 'Empty demonstration group'].map((name, index) => ({
    id: stableUuid(`group:${tenant.slug}:${index}`), tenantId: tenant.id, name,
  })));
  const recipients = [];
  const memberships = [];
  const countyTenant = tenants.find((tenant) => tenant.slug === 'demo-county');
  COUNTY_RECIPIENTS.forEach((recipient, index) => {
    const id = stableUuid(`recipient:demo-county:${recipient.key}`);
    recipients.push({
      id, tenantId: countyTenant.id, name: recipient.name,
      phone: recipient.phone ? `+1555100${String(index).padStart(2, '0')}` : null,
      email: recipient.email ? `${recipient.key}@demo-county.test` : null,
      longitude: recipient.longitude, latitude: recipient.latitude,
      ...(recipient.geographicRole ? { geographicRole: recipient.geographicRole } : {}),
    });
    const groupName = index < 10 ? 'County-wide alerts' : 'Targeted response team';
    memberships.push({ groupId: groups.find((group) => group.tenantId === countyTenant.id && group.name === groupName).id, recipientId: id, tenantId: countyTenant.id });
  });
  const schoolTenant = tenants.find((tenant) => tenant.slug === 'demo-school');
  // A 15x10 grid over Lake County, IL (Wauconda/Mundelein/Libertyville/
  // Grayslake area), the same "North Shore" region web/src/demo-geography.js
  // uses. Centered/sized to stay entirely on land: its easternmost column
  // (-87.91) stays well west of the Lake Michigan shoreline (~-87.8 at this
  // latitude) at every row, and its latitude band (42.07-42.25) stays south
  // of the Wisconsin state line (42.5). Previously this grid was centered on
  // the shoreline itself and one recipient was relocated into demo-county's
  // territory to give a "cross-tenant, same coordinates" fixture — dropped
  // because it (a) made the seed data geographically implausible for a demo
  // and (b) duplicated coverage that test/integration/fanout-store.test.js's
  // 'polygon fanout uses strict containment, excludes null and other
  // tenants' test already provides independently, with a clean synthetic
  // fixture that doesn't need to borrow another tenant's territory.
  for (let index = 0; index < 150; index += 1) {
    const id = stableUuid(`recipient:demo-school:${index}`);
    recipients.push({
      id, tenantId: schoolTenant.id, name: `Demo School Recipient ${String(index + 1).padStart(3, '0')}`,
      phone: `+1555200${String(index).padStart(2, '0')}`,
      email: `recipient-${String(index + 1).padStart(3, '0')}@demo-school.test`,
      longitude: -88.05 + ((index % 15) - 7) * 0.02,
      latitude: 42.15 + (Math.floor(index / 15) - 4) * 0.02,
    });
    const groupName = index < 100 ? 'County-wide alerts' : 'Targeted response team';
    memberships.push({ groupId: groups.find((group) => group.tenantId === schoolTenant.id && group.name === groupName).id, recipientId: id, tenantId: schoolTenant.id });
  }
  return { tenants, platformAdmins, users, groups, recipients, memberships };
}

async function seedDatabase({ client, plan = buildSeedPlan() }) {
  const tenantIds = plan.tenants.map((tenant) => tenant.id);
  await client.query('BEGIN');
  try {
    for (const table of ['alert_outbox', 'idempotency_keys', 'deliveries', 'alerts', 'group_members', 'groups', 'recipients', 'users']) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
    }
    await client.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
    // platform_admins has no tenant_id -- cleaned up by its own fixed
    // deterministic ids, not the tenant-scoped loop above.
    await client.query('DELETE FROM platform_admins WHERE id = ANY($1::uuid[])', [plan.platformAdmins.map((admin) => admin.id)]);
    for (const admin of plan.platformAdmins) await client.query(
      'INSERT INTO platform_admins (id, email, password_hash) VALUES ($1,$2,$3)', [admin.id, admin.email, admin.passwordHash]
    );
    for (const tenant of plan.tenants) await client.query(
      'INSERT INTO tenants (id, slug, name, tenant_type) VALUES ($1,$2,$3,$4)', [tenant.id, tenant.slug, tenant.name, tenant.tenantType]
    );
    for (const user of plan.users) await client.query(
      'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)', [user.id, user.tenantId, user.email, user.passwordHash, user.role]
    );
    for (const group of plan.groups) await client.query(
      'INSERT INTO groups (id, tenant_id, name) VALUES ($1,$2,$3)', [group.id, group.tenantId, group.name]
    );
    for (const recipient of plan.recipients) await client.query(
      `INSERT INTO recipients (id, tenant_id, name, phone, email, location)
       VALUES ($1,$2,$3,$4,$5,ST_SetSRID(ST_MakePoint($6,$7),4326)::geography)`,
      [recipient.id, recipient.tenantId, recipient.name, recipient.phone, recipient.email, recipient.longitude, recipient.latitude]
    );
    for (const membership of plan.memberships) await client.query(
      'INSERT INTO group_members (group_id, recipient_id, tenant_id) VALUES ($1,$2,$3)', [membership.groupId, membership.recipientId, membership.tenantId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return plan;
}

async function main() {
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const plan = await seedDatabase({ client, plan: buildSeedPlan({ demoUserPassword: config.demoUserPassword }) });
    process.stdout.write(`Seeded ${plan.tenants.length} tenants and ${plan.recipients.length} recipients.\n`);
    for (const admin of plan.platformAdmins) process.stdout.write(`platform admin: ${admin.email}\n`);
    for (const user of plan.users) process.stdout.write(`${plan.tenants.find((tenant) => tenant.id === user.tenantId).slug} ${user.role}: ${user.email}\n`);
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`Seed failed: ${error.message}\n`); process.exitCode = 1; });

module.exports = { buildSeedPlan, seedDatabase, stableUuid };
