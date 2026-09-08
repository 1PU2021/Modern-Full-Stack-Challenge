'use strict';

const { clearTimeout, setTimeout } = require('node:timers');
const { AbortController } = globalThis;

function sleepDefault(ms, { abortSignal }) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    abortSignal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function createFanoutWorker({
  receive,
  process,
  getQueueCounts,
  metrics,
  logger,
  sleep = sleepDefault,
}) {
  let started = false;
  let stopped = false;
  let phase = 'idle';
  let controller;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  async function refreshMetrics() {
    for (const queue of ['alert-fanout', 'recipient-dispatch']) {
      try {
        const counts = await getQueueCounts(queue);
        metrics.queueBacklogDepth.set({ queue }, counts.visible);
        metrics.queueInflightMessages.set({ queue }, counts.inFlight);
      } catch (error) {
        logger.error({ err: error, queue }, 'fanout queue metrics refresh failed');
      }
    }
  }

  async function run() {
    try {
      while (!stopped) {
        phase = 'receiving';
        controller = new AbortController();
        let messages;
        try {
          messages = await receive({
            maxMessages: 10,
            waitTimeSeconds: 10,
            visibilityTimeout: 60,
            abortSignal: controller.signal,
          });
        } catch (error) {
          if (error.name === 'AbortError' && stopped) break;
          logger.error({ err: error }, 'fanout receive failed');
          messages = [];
        }
        if (stopped) break;
        phase = 'processing';
        for (const message of messages || []) {
          if (stopped && phase !== 'processing') break;
          try {
            await process(message, { abortSignal: controller?.signal });
          } catch (error) {
            if (error.name === 'AbortError' && stopped) break;
            logger.error({ err: error }, 'fanout message processing failed');
          }
        }
        controller = undefined;
        phase = 'idle';
        await refreshMetrics();
        if (!stopped && (!messages || messages.length === 0)) {
          phase = 'sleeping';
          controller = new AbortController();
          await sleep(500, { abortSignal: controller.signal });
          controller = undefined;
          phase = 'idle';
        }
      }
    } finally {
      controller = undefined;
      resolveDone();
    }
  }

  return {
    get done() { return done; },
    start() {
      if (!started) {
        started = true;
        void run();
      }
      return done;
    },
    async stop() {
      stopped = true;
      if (phase === 'receiving' || phase === 'sleeping') controller?.abort();
      if (!started) resolveDone();
      return done;
    },
    async abort() {
      stopped = true;
      controller?.abort();
      if (!started) resolveDone();
      return done;
    },
  };
}

module.exports = { createFanoutWorker };
