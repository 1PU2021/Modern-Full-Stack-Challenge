'use strict';

const { loadConfig } = require('../shared/config');
const { createPool, createDb } = require('../shared/db');
const { createLogger } = require('../shared/logger');
const { createMetrics } = require('../shared/metrics');
const { createQueueClient, sendMessage } = require('../shared/queue');
const { createApp, createReadiness } = require('./app');
const { createGeocoder } = require('./geocoder');
const { createShutdownCoordinator } = require('./lifecycle');
const { createOutboxPublisher, createOutboxStore } = require('./outbox');

function start() {
  const config = loadConfig();
  const logger = createLogger('intake', { level: config.logLevel });
  const metrics = createMetrics();
  const pool = createPool(config.appDatabaseUrl);
  const db = createDb(pool);
  const queueClient = createQueueClient({
    region: config.aws.region,
    endpoint: config.aws.sqsEndpoint,
  });
  const readiness = createReadiness();
  const geocoder = createGeocoder(config.geocoder);
  const app = createApp({
    db, metrics, logger, jwtSecret: config.jwtSecret, platformJwtSecret: config.platformJwtSecret, readiness,
    geocode: geocoder.geocode,
  });
  const store = createOutboxStore({ db });
  const publisher = createOutboxPublisher({
    store,
    logger,
    send: (claim, { abortSignal }) => sendMessage(
      queueClient,
      config.queues.alertFanoutUrl,
      claim.payload,
      { abortSignal }
    ),
  });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'intake listening');
  });
  publisher.start();

  const coordinator = createShutdownCoordinator({
    readiness,
    publisher,
    server,
    pool,
    queueClient,
    logger,
    graceMs: 25_000,
    forceExit: (code) => process.exit(code),
  });
  let signalReceived = false;
  const onSignal = (signal) => {
    if (signalReceived) {
      logger.error({ signal }, 'second shutdown signal received; forcing exit');
      coordinator.force();
      return;
    }
    signalReceived = true;
    logger.info({ signal }, 'shutdown signal received');
    void coordinator.shutdown();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  server.on('error', (error) => {
    logger.error({ err: error }, 'intake server failed');
    process.exitCode = 1;
    void coordinator.shutdown();
  });
}

try {
  start();
} catch (error) {
  const logger = createLogger('intake');
  logger.error({ err: error }, 'intake startup failed');
  process.exitCode = 1;
}
