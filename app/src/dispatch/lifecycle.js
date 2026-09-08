'use strict';

const { clearTimeout, setTimeout } = require('node:timers');

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
  }));
}

function createShutdownCoordinator({ readiness, worker, server, pool, queueClient, logger, graceMs = 25_000, forceExit, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let shutdownPromise;
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    readiness.beginShutdown();
    shutdownPromise = (async () => {
      let timer;
      let timedOut = false;
      const deadline = new Promise((resolve) => {
        timer = setTimer(() => {
          timedOut = true;
          void worker.abort();
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
          void pool.end().catch((error) => logger.error({ err: error }, 'dispatch pool cleanup failed'));
          queueClient.destroy();
          forceExit(1);
          resolve();
        }, graceMs);
        timer.unref?.();
      });
      try {
        await Promise.race([Promise.all([Promise.resolve(worker.stop()), closeServer(server)]), deadline]);
        if (timedOut) return;
        clearTimer(timer);
        await pool.end();
        queueClient.destroy();
      } catch (error) {
        clearTimer(timer);
        logger.error({ err: error }, 'dispatch graceful shutdown failed');
        forceExit(1);
      }
    })();
    return shutdownPromise;
  }
  return { shutdown, force: () => forceExit(1) };
}

module.exports = { createShutdownCoordinator };
