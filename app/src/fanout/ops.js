'use strict';

const express = require('express');

function createReadiness() {
  let shuttingDown = false;
  return {
    isShuttingDown: () => shuttingDown,
    beginShutdown: () => { shuttingDown = true; },
  };
}

function createOpsApp({ db, metrics, logger, readiness }) {
  const app = express();
  app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    if (readiness.isShuttingDown()) return res.status(503).json({ status: 'not_ready' });
    try {
      await db.pool.query('SELECT 1');
      return res.status(200).json({ status: 'ready' });
    } catch (error) {
      logger.error({ err: error }, 'fanout readiness check failed');
      return res.status(503).json({ status: 'not_ready' });
    }
  });
  app.get('/metrics', async (req, res) => {
    res.type(metrics.register.contentType);
    res.send(await metrics.register.metrics());
  });
  return app;
}

module.exports = { createOpsApp, createReadiness };
