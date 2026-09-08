'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AppError, asyncHandler, errorMiddleware } = require('./errors');

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function fixture() {
  const logs = [];
  const reasons = [];
  const logger = { error(fields, message) { logs.push({ fields, message }); } };
  const metrics = { intakeRejectedTotal: { inc(labels) { reasons.push(labels.reason); } } };
  return { logs, reasons, logger, metrics };
}

test('AppError carries stable public fields', () => {
  const error = new AppError(409, 'idempotency_key_reused', 'Key reused', [{ path: 'key' }]);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'idempotency_key_reused');
  assert.deepEqual(error.details, [{ path: 'key' }]);
});

test('AppError.validation creates the approved validation error', () => {
  const error = AppError.validation([{ path: 'title', message: 'Required' }]);
  assert.equal(error.status, 400);
  assert.equal(error.code, 'validation_failed');
  assert.match(error.message, /validation_failed/);
});

test('asyncHandler forwards rejected promises', async () => {
  const boom = new Error('boom');
  let forwarded;
  await asyncHandler(async () => { throw boom; })({}, {}, (error) => { forwarded = error; });
  assert.equal(forwarded, boom);
});

test('errorMiddleware returns public AppError details and a bounded reason', () => {
  const { logger, metrics, reasons } = fixture();
  const res = fakeResponse();
  const error = AppError.validation([{ path: 'title', message: 'Required' }]);
  errorMiddleware({ logger, metrics })(error, { requestId: 'r-1' }, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    error: {
      code: 'validation_failed',
      message: 'validation_failed',
      details: [{ path: 'title', message: 'Required' }],
    },
  });
  assert.deepEqual(reasons, ['validation']);
});

test('errorMiddleware hides unknown errors, returns request id, and logs the original', () => {
  const { logger, metrics, reasons, logs } = fixture();
  const res = fakeResponse();
  const error = new Error('secret SQL details');
  errorMiddleware({ logger, metrics })(error, { requestId: 'r-2' }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    error: { code: 'internal_error', message: 'Internal server error', requestId: 'r-2' },
  });
  assert.deepEqual(reasons, ['internal']);
  assert.equal(logs[0].fields.err, error);
  assert.doesNotMatch(JSON.stringify(res.body), /secret SQL/);
});

test('errorMiddleware uses only approved metric reason labels', () => {
  const { logger, metrics, reasons } = fixture();
  const cases = [
    new AppError(401, 'invalid_token', 'bad'),
    new AppError(409, 'idempotency_key_reused', 'bad'),
    Object.assign(new Error('duplicate key value'), { code: '23505' }),
  ];
  for (const error of cases) {
    errorMiddleware({ logger, metrics })(error, { requestId: 'r' }, fakeResponse(), () => {});
  }
  assert.deepEqual(reasons, ['authentication', 'idempotency_conflict', 'database']);
});
