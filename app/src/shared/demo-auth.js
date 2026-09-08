'use strict';

const { scryptSync, timingSafeEqual } = require('node:crypto');
const { Buffer } = require('node:buffer');
const jwt = require('jsonwebtoken');

const KEY_LENGTH = 64;

function hashDemoPassword(password, salt) {
  return `scrypt$${salt}$${scryptSync(password, salt, KEY_LENGTH).toString('hex')}`;
}

function verifyDemoPassword(password, encoded) {
  const [scheme, salt, expectedHex, ...extra] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !salt || !/^[0-9a-f]{128}$/i.test(expectedHex || '') || extra.length) {
    return false;
  }
  const actual = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function issueJwt({ tenantId, userId, role, secret, impersonatedBy, sign = jwt.sign }) {
  const claims = { tenant_id: tenantId, sub: userId, role };
  if (impersonatedBy) {
    claims.impersonation = true;
    claims.impersonated_by = impersonatedBy;
  }
  return sign(claims, secret, {
    algorithm: 'HS256',
    expiresIn: '8h',
  });
}

// Platform-admin tokens are signed with a different secret (config.js's
// platformJwtSecret) and carry a claim shape with no tenant_id at all, so
// they can never be verified by the tenant-scoped auth middleware (or vice
// versa) -- see src/intake/platform-auth.js.
function issuePlatformJwt({ adminId, secret, sign = jwt.sign }) {
  return sign({ scope: 'platform', sub: adminId }, secret, {
    algorithm: 'HS256',
    expiresIn: '8h',
  });
}

module.exports = { hashDemoPassword, issueJwt, issuePlatformJwt, verifyDemoPassword };
