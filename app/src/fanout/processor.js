'use strict';

const { parseFanoutEvent, PermanentFanoutError } = require('./schemas');

function createFanoutProcessor({ store, send, ack, logger }) {
  return {
    async process(message, { abortSignal } = {}) {
      let event;
      try {
        event = parseFanoutEvent(message.Body);
      } catch (error) {
        if (!(error instanceof PermanentFanoutError)) throw error;
        logger.error({ reason: error.reason }, 'permanent fanout event rejected');
        await ack(message);
        return;
      }

      const child = logger.child({
        event_id: event.eventId,
        tenant_id: event.tenantId,
        alert_id: event.alertId,
      });
      try {
        const result = await store.materialize(event);
        for (const job of result.jobs) {
          await send(job, { abortSignal });
          child.info({
            delivery_id: job.deliveryId,
            recipient_id: job.recipientId,
            channel: job.channel,
          }, 'dispatch job published');
        }
        await ack(message);
      } catch (error) {
        if (error instanceof PermanentFanoutError) {
          await store.markFailed(event, error.reason);
          await ack(message);
          child.error({ reason: error.reason }, 'permanent fanout processing failure');
          return;
        }
        throw error;
      }
    },
  };
}

module.exports = { createFanoutProcessor };
