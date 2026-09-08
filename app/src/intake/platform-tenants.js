'use strict';

const { randomUUID } = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { hashDemoPassword, issueJwt } = require('../shared/demo-auth');
const { AppError, asyncHandler } = require('./errors');
const { parseUuidParam } = require('./schemas');

const TENANT_TYPES = ['state_agency', 'county_em', 'school_district', 'hospital_system', 'dispatch_center'];

const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(100)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens'),
  tenantType: z.enum(TENANT_TYPES),
  adminEmail: z.string().trim().email().max(320),
  adminPassword: z.string().min(8).max(1_024),
}).strict();

const setActiveSchema = z.object({ active: z.boolean() }).strict();

function throwValidation(error) {
  throw AppError.validation(error.issues.map((issue) => ({
    path: issue.path.join('.'), message: issue.message,
  })));
}

function mapTenant(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tenantType: row.tenant_type,
    active: row.active,
    createdAt: row.created_at,
  };
}

// tenants carries no RLS (see migrations/1787697925229_create-tenants-table.js),
// so this reads directly via db.pool -- there is no tenant to scope.
async function listTenants({ db }) {
  const result = await db.pool.query(
    'SELECT id, slug, name, tenant_type, active, created_at FROM tenants ORDER BY name ASC, id ASC'
  );
  return result.rows.map(mapTenant);
}

// The tenant row and its initial tenant_admin user are created in ONE
// transaction (db.withPlatformProvisioningTransaction): if either insert
// fails, both roll back together -- there is no intermediate state where a
// tenant exists without an admin, or vice versa. RLS on `users` is honored,
// not bypassed: scopeToTenant() runs the same SET LOCAL app.current_tenant
// the rest of the app uses, scoped to the tenant this same transaction just
// created.
async function createTenant({ db, input }) {
  return db.withPlatformProvisioningTransaction(async (client, scopeToTenant) => {
    let tenantRow;
    try {
      const inserted = await client.query(
        `INSERT INTO tenants (slug, name, tenant_type)
         VALUES ($1, $2, $3)
         RETURNING id, slug, name, tenant_type, active, created_at`,
        [input.slug, input.name, input.tenantType]
      );
      tenantRow = inserted.rows[0];
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'slug_taken', 'A tenant with this slug already exists');
      }
      throw error;
    }

    await scopeToTenant(tenantRow.id);

    const salt = randomUUID();
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'tenant_admin')`,
      [tenantRow.id, input.adminEmail, hashDemoPassword(input.adminPassword, salt)]
    );

    return { tenant: mapTenant(tenantRow), adminEmail: input.adminEmail };
  });
}

async function setTenantActive({ db, tenantId, active }) {
  const result = await db.pool.query(
    'UPDATE tenants SET active = $1 WHERE id = $2 RETURNING id, slug, name, tenant_type, active, created_at',
    [active, tenantId]
  );
  if (!result.rows[0]) throw new AppError(404, 'not_found', 'Tenant not found');
  return mapTenant(result.rows[0]);
}

async function impersonateTenant({ db, tenantId, platformAdminId, jwtSecret, issueToken = issueJwt }) {
  const tenantResult = await db.pool.query(
    'SELECT id, slug, name, active FROM tenants WHERE id = $1',
    [tenantId]
  );
  const tenant = tenantResult.rows[0];
  if (!tenant) throw new AppError(404, 'not_found', 'Tenant not found');
  if (!tenant.active) throw new AppError(409, 'tenant_inactive', 'Inactive tenants cannot be impersonated');

  const user = await db.withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id FROM users
       WHERE tenant_id = $1 AND role = 'tenant_admin'
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [tenantId]
    );
    return result.rows[0];
  });
  if (!user) {
    throw new AppError(409, 'tenant_admin_required', 'Tenant has no tenant administrator available for impersonation');
  }

  return {
    token: issueToken({
      tenantId, userId: user.id, role: 'tenant_admin', secret: jwtSecret,
      impersonatedBy: platformAdminId,
    }),
    role: 'tenant_admin',
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
  };
}

function createPlatformTenantsRouter({ db, jwtSecret }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json(await listTenants({ db }));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    const result = await createTenant({ db, input: parsed.data });
    res.status(201).json(result);
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const tenantId = parseUuidParam(req.params.id, 'id');
    const parsed = setActiveSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    res.json(await setTenantActive({ db, tenantId, active: parsed.data.active }));
  }));

  router.post('/:id/impersonate', asyncHandler(async (req, res) => {
    const tenantId = parseUuidParam(req.params.id, 'id');
    const result = await impersonateTenant({
      db, tenantId, platformAdminId: req.platformAuth.adminId, jwtSecret,
    });
    req.log.info({ tenant_id: tenantId, impersonated_by: req.platformAuth.adminId }, 'platform admin impersonation started');
    res.json(result);
  }));

  return router;
}

module.exports = { createPlatformTenantsRouter, createTenant, impersonateTenant, listTenants, setTenantActive };
