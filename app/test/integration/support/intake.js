'use strict';

const jwt = require('jsonwebtoken');
const { loadConfig } = require('../../../src/shared/config');
const { createPool, createDb } = require('../../../src/shared/db');
const { createMetrics } = require('../../../src/shared/metrics');
const { createLogger } = require('../../../src/shared/logger');
const { createApp, createReadiness } = require('../../../src/intake/app');
const { GeocodeError } = require('../../../src/intake/geocoder');

// Mirrors the real default ('none') provider: no address test can
// accidentally depend on a live network call unless it explicitly opts in
// via createIntakeFixture({ geocode }).
async function defaultGeocode() {
  throw new GeocodeError('Address geocoding is not configured for this environment.', { code: 'not_configured' });
}

function createIntakeFixture({ geocode = defaultGeocode } = {}) {
  const config = loadConfig();
  const pool = createPool(config.appDatabaseUrl);
  const db = createDb(pool);
  const metrics = createMetrics();
  const logger = createLogger('intake-test', { level: 'silent' });
  const readiness = createReadiness();
  const app = createApp({
    db,
    metrics,
    logger,
    jwtSecret: config.jwtSecret,
    platformJwtSecret: config.platformJwtSecret,
    readiness,
    geocode,
  });
  return {
    app,
    pool,
    metrics,
    sign({ tenantId, userId, role = 'operator' }) {
      return jwt.sign({ tenant_id: tenantId, sub: userId, role }, config.jwtSecret, {
        algorithm: 'HS256',
      });
    },
    signPlatform({ adminId }) {
      return jwt.sign({ scope: 'platform', sub: adminId }, config.platformJwtSecret, {
        algorithm: 'HS256',
      });
    },
  };
}

module.exports = { createIntakeFixture };
