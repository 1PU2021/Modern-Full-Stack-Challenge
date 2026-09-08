'use strict';

const jwt = require('jsonwebtoken');
const { AppError } = require('./errors');
const { parseUuidParam } = require('./schemas');

const TENANT_ROLES = ['operator', 'tenant_admin'];

function createAuthMiddleware({ jwtSecret }) {
  return (req, res, next) => {
    void res;
    const parts = (req.headers.authorization || '').split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
      return next(
        new AppError(401, 'authentication_required', 'Bearer token required')
      );
    }

    try {
      const claims = jwt.verify(parts[1], jwtSecret, { algorithms: ['HS256'] });
      if (!TENANT_ROLES.includes(claims.role)) {
        throw new Error('unknown or missing role claim');
      }
      req.auth = {
        tenantId: parseUuidParam(claims.tenant_id, 'tenant_id'),
        userId: parseUuidParam(claims.sub, 'sub'),
        role: claims.role,
      };
      return next();
    } catch {
      return next(
        new AppError(401, 'invalid_token', 'Token is invalid or expired')
      );
    }
  };
}

// Enforces authorization server-side, independent of any frontend nav
// hiding. Route factories apply this per-route (e.g.
// `router.post('/', requireRole('tenant_admin'), asyncHandler(...))`), never
// relying on the client to only call routes it's "supposed to."
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    void res;
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return next(new AppError(403, 'forbidden', 'You do not have permission to perform this action'));
    }
    return next();
  };
}

module.exports = { createAuthMiddleware, requireRole };
