'use strict';

const { z } = require('zod');

class PermanentFanoutError extends Error {
  constructor(reason, message = 'Fanout message cannot be processed') {
    super(message);
    this.name = 'PermanentFanoutError';
    this.reason = reason;
  }
}

const uuid = z.string().uuid();
const eventSchema = z.object({ eventId: uuid, alertId: uuid, tenantId: uuid }).strict();
const position = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

function samePosition(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

const ring = z.array(position).min(4).max(1_000).superRefine((positions, context) => {
  if (!samePosition(positions[0], positions.at(-1))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Ring must be closed' });
  }
  const distinct = new Set(positions.slice(0, -1).map(([x, y]) => `${x}:${y}`));
  if (distinct.size < 3) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Ring must contain three distinct vertices',
    });
  }
});

const coordinates = z.array(ring).min(1).max(20).superRefine((rings, context) => {
  if (rings.reduce((total, positions) => total + positions.length, 0) > 2_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Polygon is too large' });
  }
});
const groupTarget = z.object({ type: z.literal('group'), groupId: uuid }).strict();
const polygonTarget = z.object({
  type: z.literal('polygon'),
  geojson: z.object({ type: z.literal('Polygon'), coordinates }).strict(),
}).strict();
const channelSchema = z.array(z.enum(['sms', 'email'])).min(1).max(2)
  .refine((channels) => new Set(channels).size === channels.length);
const storedAlertSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  channels: channelSchema,
  target: z.discriminatedUnion('type', [groupTarget, polygonTarget]),
  status: z.enum(['accepted', 'expanding', 'dispatching', 'completed', 'failed']),
}).strict();

function parseFanoutEvent(body) {
  try {
    const value = JSON.parse(body);
    return eventSchema.parse(value);
  } catch {
    throw new PermanentFanoutError('invalid_event', 'Invalid fanout event');
  }
}

function parseStoredAlert(row) {
  const parsed = storedAlertSchema.safeParse(row);
  if (!parsed.success) {
    throw new PermanentFanoutError('invalid_stored_alert', 'Invalid stored alert');
  }
  return {
    id: parsed.data.id,
    tenantId: parsed.data.tenant_id,
    channels: ['sms', 'email'].filter((channel) => parsed.data.channels.includes(channel)),
    target: parsed.data.target,
    status: parsed.data.status,
  };
}

module.exports = { parseFanoutEvent, parseStoredAlert, PermanentFanoutError };
