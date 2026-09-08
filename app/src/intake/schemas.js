'use strict';

const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { AppError } = require('./errors');

const CHANNEL_ORDER = ['sms', 'email'];

function codePointLength(value) {
  return Array.from(value).length;
}

function boundedText(max, label) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, `${label} cannot be whitespace-only`)
    .refine((value) => codePointLength(value) <= max, `${label} must contain at most ${max} characters`);
}

const longitude = z.number().finite().min(-180).max(180);
const latitude = z.number().finite().min(-90).max(90);
const position = z.tuple([longitude, latitude]);

function positionsEqual(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

const ring = z
  .array(position)
  .min(4)
  .max(1_000)
  .superRefine((positions, context) => {
    if (positions.length >= 2 && !positionsEqual(positions[0], positions.at(-1))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Ring must be closed' });
    }
    const distinct = new Set(positions.slice(0, -1).map(([lon, lat]) => `${lon}:${lat}`));
    if (distinct.size < 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ring must contain at least three distinct vertices',
      });
    }
  });

const polygonCoordinates = z
  .array(ring)
  .min(1)
  .max(20)
  .superRefine((rings, context) => {
    const total = rings.reduce((count, positions) => count + positions.length, 0);
    if (total > 2_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Polygon must contain at most 2000 positions',
      });
    }
  });

const groupTarget = z
  .object({ type: z.literal('group'), groupId: z.string().uuid() })
  .strict();

const polygonTarget = z
  .object({
    type: z.literal('polygon'),
    geojson: z.object({ type: z.literal('Polygon'), coordinates: polygonCoordinates }).strict(),
  })
  .strict();

const channels = z
  .array(z.enum(CHANNEL_ORDER))
  .min(1)
  .max(2)
  .refine((items) => new Set(items).size === items.length, 'Channels must not contain duplicates');

const alertSchema = z
  .object({
    title: boundedText(200, 'Title'),
    body: boundedText(10_000, 'Body'),
    priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
    channels,
    target: z.discriminatedUnion('type', [groupTarget, polygonTarget]),
  })
  .strict();

const idempotencyKeySchema = boundedText(255, 'Idempotency-Key');

function formatIssues(issues, prefix = []) {
  return issues.map((issue) => ({
    path: [...prefix, ...issue.path].join('.'),
    message: issue.message,
  }));
}

function parseAlertRequest({ body, idempotencyKey }) {
  const parsedBody = alertSchema.safeParse(body);
  const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey ?? randomUUID());
  if (!parsedBody.success || !parsedKey.success) {
    const details = [
      ...(parsedBody.success ? [] : formatIssues(parsedBody.error.issues)),
      ...(parsedKey.success ? [] : formatIssues(parsedKey.error.issues, ['idempotencyKey'])),
    ];
    throw AppError.validation(details);
  }

  return {
    ...parsedBody.data,
    channels: CHANNEL_ORDER.filter((channel) => parsedBody.data.channels.includes(channel)),
    idempotencyKey: parsedKey.data,
  };
}

function parseUuidParam(value, name) {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw AppError.validation([{ path: name, message: 'Must be a UUID' }]);
  }
  return parsed.data;
}

module.exports = { parseAlertRequest, parseUuidParam, longitude, latitude };
