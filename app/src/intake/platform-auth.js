'use strict';

const jwt = require('jsonwebtoken');
const { AppError } = require('./errors');
const { parseUuidParam } = require('./schemas');

// Deliberately separate from createAuthMiddleware (auth.js): platform-admin
// tokens are signed with a different secret (config.platformJwtSecret) and
// carry a distinct claim shape (scope: 'platform', no tenant_id at all), so
// a tenant token can never pass here and a platform token can never pass
// the tenant middleware -- neither has to trust the other's shape.
function createPlatformAuthMiddleware({ jwtSecret }) {
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
      if (claims.scope !== 'platform') {
        throw new Error('not a platform-scoped token');
      }
      req.platformAuth = {
        adminId: parseUuidParam(claims.sub, 'sub'),
      };
      return next();
    } catch {
      return next(
        new AppError(401, 'invalid_token', 'Token is invalid or expired')
      );
    }
  };
}

module.exports = { createPlatformAuthMiddleware };
