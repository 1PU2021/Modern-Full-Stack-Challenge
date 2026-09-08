'use strict';

const express = require('express');
const { z } = require('zod');
const { issuePlatformJwt, verifyDemoPassword } = require('../shared/demo-auth');
const { AppError, asyncHandler } = require('./errors');

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1_024),
}).strict();

function invalidCredentials() {
  return new AppError(401, 'invalid_credentials', 'Invalid email or password');
}

// platform_admins carries no RLS (it's not tenant data), so this reads
// directly via db.pool -- there is no tenant to scope with withTenant().
async function authenticatePlatformAdmin({ db, jwtSecret, email, password, issueToken = issuePlatformJwt }) {
  const result = await db.pool.query(
    'SELECT id, password_hash FROM platform_admins WHERE lower(email) = lower($1)',
    [email]
  );
  const admin = result.rows[0];
  if (!admin || !verifyDemoPassword(password, admin.password_hash)) throw invalidCredentials();

  return { token: issueToken({ adminId: admin.id, secret: jwtSecret }) };
}

function createPlatformLoginRouter({ db, jwtSecret }) {
  const router = express.Router();
  router.post('/', asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation(parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'), message: issue.message,
      })));
    }
    res.json(await authenticatePlatformAdmin({ db, jwtSecret, ...parsed.data }));
  }));
  return router;
}

module.exports = { authenticatePlatformAdmin, createPlatformLoginRouter };
