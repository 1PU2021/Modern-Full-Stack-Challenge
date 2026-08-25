'use strict';

const pino = require('pino');

function createLogger(service, { level = 'info' } = {}) {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger };
