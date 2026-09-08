'use strict';

const { randomUUID } = require('node:crypto');
const express = require('express');
const { createAuthMiddleware } = require('./auth');
const { createPlatformAuthMiddleware } = require('./platform-auth');
const { AppError, asyncHandler, errorMiddleware } = require('./errors');

function createReadiness() {
  let shuttingDown = false;
  return {
    isShuttingDown() { return shuttingDown; },
    beginShutdown() { shuttingDown = true; },
  };
}

function validRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function requestContext(logger) {
  return (req, res, next) => {
    const incoming = req.get('X-Request-ID');
    req.requestId = validRequestId(incoming) ? incoming : randomUUID();
    req.log = logger.child({ request_id: req.requestId });
    res.set('X-Request-ID', req.requestId);
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      req.log.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: durationMs,
        },
        'request completed'
      );
    });
    next();
  };
}

function resolveRouteFactories(routeFactories) {
  if (routeFactories) return routeFactories;
  return {
    createLoginRouter: require('./login').createLoginRouter,
    createAlertsRouter: require('./alerts').createAlertsRouter,
    createGroupsRouter: require('./groups').createGroupsRouter,
    createRecipientsRouter: require('./recipients').createRecipientsRouter,
    createUsersRouter: require('./users').createUsersRouter,
    createPlatformLoginRouter: require('./platform-login').createPlatformLoginRouter,
    createPlatformTenantsRouter: require('./platform-tenants').createPlatformTenantsRouter,
  };
}

function createApp({ db, metrics, logger, jwtSecret, platformJwtSecret, readiness, geocode, routeFactories }) {
  const app = express();
  const routes = resolveRouteFactories(routeFactories);

  app.use(requestContext(logger));
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    if (readiness.isShuttingDown()) {
      return res.status(503).json({ status: 'not_ready' });
    }
    try {
      await db.pool.query('SELECT 1');
      return res.status(200).json({ status: 'ready' });
    } catch (error) {
      req.log.error({ err: error }, 'readiness check failed');
      return res.status(503).json({ status: 'not_ready' });
    }
  });
  app.get(
    '/metrics',
    asyncHandler(async (req, res) => {
      res.type(metrics.register.contentType);
      res.send(await metrics.register.metrics());
    })
  );

  app.use('/api/auth/login', routes.createLoginRouter({ db, jwtSecret }));

  app.use('/api/v1', createAuthMiddleware({ jwtSecret, metrics }));
  app.use('/api/v1', (req, res, next) => {
    req.log = req.log.child({ tenant_id: req.auth.tenantId });
    next();
  });
  app.use('/api/v1/alerts', routes.createAlertsRouter({ db, metrics }));
  app.use('/api/v1/groups', routes.createGroupsRouter({ db }));
  app.use('/api/v1/recipients', routes.createRecipientsRouter({ db, geocode }));
  app.use('/api/v1/users', routes.createUsersRouter({ db }));

  // Platform-admin routes are deliberately isolated from /api/v1: a
  // separate login endpoint, a separate auth middleware verifying a
  // different signing secret and claim shape (see platform-auth.js), and
  // they never call db.withTenant() -- tenants/platform_admins carry no
  // RLS to scope.
  app.use('/api/platform/auth/login', routes.createPlatformLoginRouter({ db, jwtSecret: platformJwtSecret }));
  app.use('/api/platform', createPlatformAuthMiddleware({ jwtSecret: platformJwtSecret }));
  app.use('/api/platform', (req, res, next) => {
    req.log = req.log.child({ platform_admin_id: req.platformAuth.adminId });
    next();
  });
  app.use('/api/platform/tenants', routes.createPlatformTenantsRouter({ db, jwtSecret }));

  app.use((req, res, next) => {
    void res;
    next(new AppError(404, 'not_found', 'Route not found'));
  });
  app.use(errorMiddleware({ logger, metrics }));

  return app;
}

module.exports = { createApp, createReadiness };
