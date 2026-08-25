'use strict';

const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AWS_REGION: z.string().min(1, 'AWS_REGION is required'),
  SQS_ENDPOINT: z.string().optional(),
  ALERT_FANOUT_QUEUE_URL: z.string().min(1, 'ALERT_FANOUT_QUEUE_URL is required'),
  RECIPIENT_DISPATCH_QUEUE_URL: z.string().min(1, 'RECIPIENT_DISPATCH_QUEUE_URL is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  SMS_PROVIDER_URL: z.string().default('http://localhost:4000'),
  EMAIL_PROVIDER_URL: z.string().default('http://localhost:4001'),
  MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const field = issue.path.join('.');
        if (issue.message === 'Required') {
          return `${field} is required`;
        }
        return `${field}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }

  const data = parsed.data;
  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    databaseUrl: data.DATABASE_URL,
    aws: {
      region: data.AWS_REGION,
      sqsEndpoint: data.SQS_ENDPOINT,
    },
    queues: {
      alertFanoutUrl: data.ALERT_FANOUT_QUEUE_URL,
      recipientDispatchUrl: data.RECIPIENT_DISPATCH_QUEUE_URL,
    },
    jwtSecret: data.JWT_SECRET,
    providers: {
      smsUrl: data.SMS_PROVIDER_URL,
      emailUrl: data.EMAIL_PROVIDER_URL,
    },
    maxDeliveryAttempts: data.MAX_DELIVERY_ATTEMPTS,
  };
}

module.exports = { loadConfig };
