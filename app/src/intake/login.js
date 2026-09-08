'use strict';

const express = require('express');
const { z } = require('zod');
const { issueJwt, verifyDemoPassword } = require('../shared/demo-auth');
const { AppError, asyncHandler } = require('./errors');

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1_024),
}).strict();

function invalidCredentials() {
  return new AppError(401, 'invalid_credentials', 'Invalid email or password');
}

function parseLoginRequest(body) {
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    throw AppError.validation(parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'), message: issue.message,
    })));
  }
  return parsed.data;
}

async function authenticateDemoUser({ db, jwtSecret, email, password, issueToken = issueJwt }) {
  const result = await db.pool.query(
    'SELECT * FROM public.find_tenant_user_for_login($1)',
    [email]
  );
  const identity = result.rows[0];
  if (!identity || !identity.tenant_active || !verifyDemoPassword(password, identity.password_hash)) {
    throw invalidCredentials();
  }

  return {
    token: issueToken({
      tenantId: identity.tenant_id, userId: identity.user_id,
      role: identity.role, secret: jwtSecret,
    }),
    role: identity.role,
    tenant: { id: identity.tenant_id, slug: identity.tenant_slug, name: identity.tenant_name },
  };
}

function createLoginRouter({ db, jwtSecret }) {
  const router = express.Router();
  router.post('/', asyncHandler(async (req, res) => {
    const credentials = parseLoginRequest(req.body);
    res.json(await authenticateDemoUser({ db, jwtSecret, ...credentials }));
  }));
  return router;
}

module.exports = { authenticateDemoUser, createLoginRouter, parseLoginRequest };
