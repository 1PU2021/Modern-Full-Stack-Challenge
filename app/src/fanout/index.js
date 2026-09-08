'use strict';

const { loadConfig } = require('../shared/config');
const { createPool, createDb } = require('../shared/db');
const { createLogger } = require('../shared/logger');
const { createMetrics } = require('../shared/metrics');
const {
  createQueueClient, receiveMessages, sendMessage, deleteMessage, getQueueCounts,
} = require('../shared/queue');
const { createFanoutStore } = require('./store');
const { createFanoutProcessor } = require('./processor');
const { createFanoutWorker } = require('./worker');
const { createOpsApp, createReadiness } = require('./ops');
const { createShutdownCoordinator } = require('./lifecycle');

function startFanout(overrides = {}) {
  const factories = {
    loadConfig, createPool, createDb, createLogger, createMetrics, createQueueClient,
    receiveMessages, sendMessage, deleteMessage, getQueueCounts,
    createFanoutStore, createFanoutProcessor, createFanoutWorker,
    createOpsApp, createReadiness, createShutdownCoordinator,
    ...overrides,
  };
  const config = factories.loadConfig();
  const logger = factories.createLogger('fanout', { level: config.logLevel });
  const metrics = factories.createMetrics();
  const pool = factories.createPool(config.appDatabaseUrl);
  const db = factories.createDb(pool);
  const queueClient = factories.createQueueClient(config.aws);
  const readiness = factories.createReadiness();
  const store = factories.createFanoutStore({ db });
  const receive = (options) => factories.receiveMessages(
    queueClient, config.queues.alertFanoutUrl, options
  );
  const send = (job, options) => factories.sendMessage(
    queueClient, config.queues.recipientDispatchUrl, job, options
  );
  const ack = (message) => factories.deleteMessage(
    queueClient, config.queues.alertFanoutUrl, message.ReceiptHandle
  );
  const getCounts = (queue) => factories.getQueueCounts(
    queueClient,
    queue === 'alert-fanout' ? config.queues.alertFanoutUrl : config.queues.recipientDispatchUrl
  );
  const processor = factories.createFanoutProcessor({ store, send, ack, logger });
  const worker = factories.createFanoutWorker({ receive, process: processor.process, getQueueCounts: getCounts, metrics, logger });
  const app = factories.createOpsApp({ db, metrics, logger, readiness });
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'fanout listening'));
  const coordinator = factories.createShutdownCoordinator({
    readiness, worker, server, pool, queueClient, logger, graceMs: 25_000,
    forceExit: (code) => process.exit(code),
  });
  worker.start();
  if (overrides.installSignals) {
    let signaled = false;
    const onSignal = (signal) => {
      if (signaled) { logger.error({ signal }, 'second shutdown signal received; forcing exit'); coordinator.force(); return; }
      signaled = true;
      logger.info({ signal }, 'shutdown signal received');
      void coordinator.shutdown();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }
  server.on?.('error', (error) => {
    logger.error({ err: error }, 'fanout server failed');
    process.exitCode = 1;
    void coordinator.shutdown();
  });
  return { config, queueClient, receive, send, ack, getCounts, processor, worker, server, coordinator };
}

if (require.main === module) {
  try {
    startFanout({ installSignals: true });
  } catch (error) {
    const logger = createLogger('fanout');
    logger.error({ err: error }, 'fanout startup failed');
    process.exitCode = 1;
  }
}

module.exports = { startFanout };
