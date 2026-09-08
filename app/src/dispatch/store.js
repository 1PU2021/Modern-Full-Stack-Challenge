'use strict';

const { PermanentDispatchError } = require('./schemas');

function createDispatchStore({ db, maxAttempts }) {
  async function beginAttempt(job) {
    return db.withTenant(job.tenantId, async (client) => {
      const selected = await client.query(
        `SELECT id, tenant_id, alert_id, recipient_id, channel, status, attempt_count, created_at, provider_response
         FROM deliveries
         WHERE tenant_id = $1 AND id = $2 AND alert_id = $3
           AND recipient_id = $4 AND channel = $5
         FOR UPDATE`,
        [job.tenantId, job.deliveryId, job.alertId, job.recipientId, job.channel]
      );
      const delivery = selected.rows[0];
      if (!delivery) throw new PermanentDispatchError('delivery_not_found', 'Delivery not found');
      const permanentlyFailed = delivery.provider_response?.permanent === true
        || delivery.provider_response?.permanent === 'true';
      if (delivery.status === 'delivered' || permanentlyFailed || Number(delivery.attempt_count) >= maxAttempts) {
        return { kind: 'skip' };
      }
      const updated = await client.query(
        `UPDATE deliveries
         SET attempt_count = attempt_count + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status <> 'delivered'
         RETURNING id, tenant_id, alert_id, recipient_id, channel, status,
                   attempt_count, created_at`,
        [job.tenantId, job.deliveryId]
      );
      const attempt = updated.rows[0] || { ...delivery, attempt_count: Number(delivery.attempt_count) + 1 };
      return { kind: 'attempt', attemptCount: Number(attempt.attempt_count), delivery: attempt };
    });
  }

  async function recordOutcome(job, attempt, result) {
    return db.withTenant(job.tenantId, async (client) => {
      const terminal = result.outcome === 'delivered'
        || result.permanent
        || attempt >= maxAttempts;
      const response = { ...(result.response || {}), ...(result.permanent ? { permanent: true } : {}) };
      await client.query(
        `UPDATE deliveries
         SET status = $3,
             provider_response = $4::jsonb,
             updated_at = now(),
             delivered_at = CASE WHEN $3 = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END
         WHERE tenant_id = $1 AND id = $2 AND alert_id = $5
           AND recipient_id = $6 AND channel = $7
           AND status <> 'delivered'`,
        [job.tenantId, job.deliveryId, result.outcome, JSON.stringify(response),
          job.alertId, job.recipientId, job.channel]
      );
      if (terminal) {
        const remaining = await client.query(
          `SELECT count(*)
           FROM deliveries
           WHERE tenant_id = $1 AND alert_id = $2
             AND (status = 'pending' OR (attempt_count < $3 AND (provider_response->>'permanent') IS DISTINCT FROM 'true'))`,
          [job.tenantId, job.alertId, maxAttempts]
        );
        if (Number(remaining.rows[0]?.count || 0) === 0) {
          await client.query(
            `UPDATE alerts SET status = 'completed', completed_at = now()
             WHERE tenant_id = $1 AND id = $2 AND status <> 'completed'`,
            [job.tenantId, job.alertId]
          );
        }
      }
      return { terminal, status: result.outcome };
    });
  }

  return { beginAttempt, recordOutcome };
}

module.exports = { createDispatchStore };
