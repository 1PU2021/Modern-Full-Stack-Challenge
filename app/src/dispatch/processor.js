'use strict';

const { parseDispatchJob, PermanentDispatchError } = require('./schemas');

function createDispatchProcessor({ store, providers, ack, metrics, logger, now = () => Date.now() }) {
  async function process(message, { abortSignal } = {}) {
    let job;
    try {
      job = parseDispatchJob(message.Body);
    } catch (error) {
      if (!(error instanceof PermanentDispatchError)) throw error;
      logger.error({ reason: error.reason }, 'permanent dispatch message rejected');
      await ack(message);
      return;
    }

    const child = logger.child({
      delivery_id: job.deliveryId,
      alert_id: job.alertId,
      tenant_id: job.tenantId,
      channel: job.channel,
    });
    let attempt;
    try {
      attempt = await store.beginAttempt(job);
    } catch (error) {
      if (!(error instanceof PermanentDispatchError)) throw error;
      child.error({ reason: error.reason }, 'permanent dispatch delivery rejected');
      await ack(message);
      return;
    }
    if (attempt.kind === 'skip') {
      await ack(message);
      return;
    }

    const providerResult = await providers.send(job, { abortSignal });
    const recorded = await store.recordOutcome(job, attempt.attemptCount, providerResult);
    metrics.deliveryOutcomeTotal.inc({ channel: job.channel, outcome: providerResult.outcome });
    if (recorded.terminal) {
      const created = new Date(attempt.delivery?.created_at || now()).getTime();
      metrics.intakeToDeliverySeconds.observe(
        { channel: job.channel },
        Math.max(0, (now() - created) / 1000)
      );
      await ack(message);
    }
    child.info({ attempt_count: attempt.attemptCount, outcome: providerResult.outcome }, 'dispatch outcome recorded');
  }
  return { process };
}

module.exports = { createDispatchProcessor };
