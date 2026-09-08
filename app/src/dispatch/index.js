'use strict';

const { loadConfig } = require('../shared/config');
const { createPool, createDb } = require('../shared/db');
const { createLogger } = require('../shared/logger');
const { createMetrics } = require('../shared/metrics');
const { createQueueClient, receiveMessages, deleteMessage, getQueueCounts } = require('../shared/queue');
const { createProviderClient } = require('./providers');
const { createDispatchStore } = require('./store');
const { createDispatchProcessor } = require('./processor');
const { createDispatchWorker } = require('./worker');
const { createOpsApp, createReadiness } = require('./ops');
const { createShutdownCoordinator } = require('./lifecycle');

function startDispatch(overrides = {}) {
  const factories = {
    loadConfig, createPool, createDb, createLogger, createMetrics, createQueueClient,
    createProviderClient, createDispatchStore, createDispatchProcessor, createDispatchWorker,
    createOpsApp, createReadiness, createShutdownCoordinator,
    receiveMessages, deleteMessage, getQueueCounts, ...overrides,
  };
  const config = factories.loadConfig();
  const logger = factories.createLogger('dispatch', { level: config.logLevel });
  const metrics = factories.createMetrics();
  const pool = factories.createPool(config.appDatabaseUrl);
  const db = factories.createDb(pool);
  const queueClient = factories.createQueueClient(config.aws);
  const readiness = factories.createReadiness();
  const providers = factories.createProviderClient({ urls: { sms: config.providers.smsUrl, email: config.providers.emailUrl }, timeoutMs: 25_000 });
  const store = factories.createDispatchStore({ db, maxAttempts: config.maxDeliveryAttempts });
  const receive = (options) => factories.receiveMessages(queueClient, config.queues.recipientDispatchUrl, options);
  const ack = (message) => factories.deleteMessage(queueClient, config.queues.recipientDispatchUrl, message.ReceiptHandle);
  const getCounts = () => factories.getQueueCounts(queueClient, config.queues.recipientDispatchUrl);
  const processor = factories.createDispatchProcessor({ store, providers, ack, metrics, logger });
  const worker = factories.createDispatchWorker({ receive, process: processor.process, getQueueCounts: getCounts, metrics, logger });
  const app = factories.createOpsApp({ db, metrics, logger, readiness });
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'dispatch listening'));
  const coordinator = factories.createShutdownCoordinator({ readiness, worker, server, pool, queueClient, logger, graceMs: 25_000, forceExit: (code) => process.exit(code) });
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
  server.on?.('error', (error) => { logger.error({ err: error }, 'dispatch server failed'); process.exitCode = 1; void coordinator.shutdown(); });
  return { config, queueClient, providers, receive, ack, getCounts, processor, worker, server, coordinator };
}

if (require.main === module) {
  try { startDispatch({ installSignals: true }); } catch (error) { createLogger('dispatch').error({ err: error }, 'dispatch startup failed'); process.exitCode = 1; }
}

module.exports = { startDispatch };
