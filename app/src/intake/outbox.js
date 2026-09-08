'use strict';

const { randomUUID } = require('node:crypto');
const { clearTimeout, setTimeout } = require('node:timers');
const { AbortController } = globalThis;

function retryDelaySeconds(attempt) {
  return Math.min(2 ** (attempt - 1), 60);
}

function truncateError(error) {
  return Array.from(String(error?.message ?? error)).slice(0, 1_000).join('');
}

function mapClaim(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    alertId: row.alert_id,
    payload: row.payload,
    attemptCount: Number(row.attempt_count),
    claimToken: row.claim_token,
    claimedUntil: row.claimed_until,
  };
}

function createOutboxStore({ db }) {
  return {
    async listTenantIds() {
      const result = await db.pool.query('SELECT id FROM tenants ORDER BY id');
      return result.rows.map((row) => row.id);
    },

    async claimNext(tenantId) {
      return db.withTenant(tenantId, async (client) => {
        const token = randomUUID();
        const result = await client.query(
          `WITH candidate AS (
             SELECT id FROM alert_outbox
             WHERE tenant_id = $1 AND published_at IS NULL AND available_at <= now()
               AND (claim_token IS NULL OR claimed_until <= now())
             ORDER BY available_at, created_at, id
             FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE alert_outbox AS o
           SET claim_token = $2, claimed_until = now() + interval '60 seconds'
           FROM candidate
           WHERE o.id = candidate.id AND o.tenant_id = $1
           RETURNING o.id, o.tenant_id, o.alert_id, o.payload, o.attempt_count,
                     o.claim_token, o.claimed_until`,
          [tenantId, token]
        );
        return result.rows[0] ? mapClaim(result.rows[0]) : null;
      });
    },

    async recordSuccess(claim) {
      return db.withTenant(claim.tenantId, async (client) => {
        const result = await client.query(
          `UPDATE alert_outbox SET published_at = now(), claim_token = NULL, claimed_until = NULL
           WHERE id = $1 AND tenant_id = $2 AND claim_token = $3 AND published_at IS NULL`,
          [claim.id, claim.tenantId, claim.claimToken]
        );
        return result.rowCount === 1;
      });
    },

    async recordFailure(claim, error) {
      const attempt = claim.attemptCount + 1;
      return db.withTenant(claim.tenantId, async (client) => {
        const result = await client.query(
          `UPDATE alert_outbox
           SET attempt_count = attempt_count + 1,
               available_at = now() + make_interval(secs => $4),
               last_error = $5, claim_token = NULL, claimed_until = NULL
           WHERE id = $1 AND tenant_id = $2 AND claim_token = $3 AND published_at IS NULL`,
          [claim.id, claim.tenantId, claim.claimToken, retryDelaySeconds(attempt), truncateError(error)]
        );
        return result.rowCount === 1;
      });
    },
  };
}

function abortableSleep(ms, { abortSignal }) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    abortSignal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function createOutboxPublisher({ store, send, logger, sleep = abortableSleep }) {
  let stopped = false;
  let started = false;
  let sendController;
  let idleController;
  let abortedController;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  async function run() {
    try {
      while (!stopped) {
        let foundWork = false;
        const tenantIds = await store.listTenantIds();
        for (const tenantId of tenantIds) {
          if (stopped) break;
          const claim = await store.claimNext(tenantId);
          if (!claim) continue;
          foundWork = true;
          const controller = new AbortController();
          sendController = controller;
          try {
            await send(claim, { abortSignal: controller.signal });
            if (abortedController !== controller) await store.recordSuccess(claim);
          } catch (error) {
            if (abortedController !== controller) {
              await store.recordFailure(claim, error);
              logger.error({ err: error, event_id: claim.id }, 'outbox publish failed');
            }
          } finally {
            if (sendController === controller) sendController = undefined;
          }
        }
        if (!stopped && !foundWork) {
          idleController = new AbortController();
          await sleep(500, { abortSignal: idleController.signal });
          idleController = undefined;
        }
      }
    } finally {
      resolveDone();
    }
  }

  return {
    get done() { return done; },
    start() {
      if (!started) {
        started = true;
        void run();
      }
      return done;
    },
    async stop() {
      stopped = true;
      idleController?.abort();
      if (!started) resolveDone();
      return done;
    },
    async abort() {
      stopped = true;
      abortedController = sendController;
      sendController?.abort();
      idleController?.abort();
      if (!started) resolveDone();
      return done;
    },
  };
}

module.exports = { createOutboxPublisher, createOutboxStore, retryDelaySeconds };
