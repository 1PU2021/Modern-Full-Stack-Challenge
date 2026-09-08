'use strict';

const { z } = require('zod');

class PermanentDispatchError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'PermanentDispatchError';
    this.reason = reason;
    this.permanent = true;
  }
}

const jobSchema = z.object({
  deliveryId: z.string().uuid(),
  alertId: z.string().uuid(),
  tenantId: z.string().uuid(),
  recipientId: z.string().uuid(),
  channel: z.enum(['sms', 'email']),
}).strict();

function parseDispatchJob(body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    throw new PermanentDispatchError('invalid_message', 'Invalid dispatch message');
  }
  const result = jobSchema.safeParse(parsed);
  if (!result.success) {
    throw new PermanentDispatchError('invalid_message', 'Invalid dispatch message');
  }
  return result.data;
}

module.exports = { PermanentDispatchError, parseDispatchJob };
