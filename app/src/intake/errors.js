'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static validation(details) {
    return new AppError(400, 'validation_failed', 'validation_failed', details);
  }
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function metricReason(error) {
  if (error.type === 'entity.too.large' || error.code === 'validation_failed') return 'validation';
  if (error.status === 401) return 'authentication';
  if (error.code === 'idempotency_key_reused') return 'idempotency_conflict';
  if (typeof error.code === 'string' && /^[0-9]{2}[A-Z0-9]{3}$/.test(error.code)) {
    return 'database';
  }
  return 'internal';
}

function errorMiddleware({ logger, metrics }) {
  return (error, req, res, next) => {
    void next;
    metrics.intakeRejectedTotal.inc({ reason: metricReason(error) });

    const requestLogger = req.log || logger;
    requestLogger.error({ err: error, request_id: req.requestId }, 'request failed');

    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'payload_too_large', message: 'Request body exceeds 256 KB' },
      });
    }

    if (error instanceof AppError) {
      const publicError = { code: error.code, message: error.message };
      if (error.details !== undefined) publicError.details = error.details;
      return res.status(error.status).json({ error: publicError });
    }

    return res.status(500).json({
      error: {
        code: 'internal_error',
        message: 'Internal server error',
        requestId: req.requestId,
      },
    });
  };
}

module.exports = { AppError, asyncHandler, errorMiddleware };
