'use strict';

const { randomUUID } = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { hashDemoPassword } = require('../shared/demo-auth');
const { AppError, asyncHandler } = require('./errors');
const { requireRole } = require('./auth');

// List + create only for this pass, per project decision: edit, deactivate,
// and password reset for tenant users are documented follow-up work, not
// implemented here, to keep this addition proportionate.
const createUserSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(1_024),
  role: z.enum(['operator', 'tenant_admin']),
}).strict();

function throwValidation(error) {
  throw AppError.validation(error.issues.map((issue) => ({
    path: issue.path.join('.'), message: issue.message,
  })));
}

function mapUser(row) {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at };
}

async function listUsers({ db, auth }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      'SELECT id, email, role, created_at FROM users WHERE tenant_id = $1 ORDER BY email ASC, id ASC',
      [auth.tenantId]
    );
    return result.rows.map(mapUser);
  });
}

async function createUser({ db, auth, input }) {
  return db.withTenant(auth.tenantId, async (client) => {
    try {
      const salt = randomUUID();
      const result = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, role, created_at`,
        [auth.tenantId, input.email, hashDemoPassword(input.password, salt), input.role]
      );
      return mapUser(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'email_taken', 'A user with this email already exists');
      }
      throw error;
    }
  });
}

function createUsersRouter({ db }) {
  const router = express.Router();
  router.use(requireRole('tenant_admin'));

  router.get('/', asyncHandler(async (req, res) => {
    res.json(await listUsers({ db, auth: req.auth }));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    res.status(201).json(await createUser({ db, auth: req.auth, input: parsed.data }));
  }));

  return router;
}

module.exports = { createUsersRouter, createUser, listUsers };
