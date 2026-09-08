'use strict';

const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const express = require('express');
const { AppError, asyncHandler } = require('./errors');
const { parseAlertRequest } = require('./schemas');

const STATUS_ORDER = ['pending', 'delivered', 'failed', 'rate_limited', 'timed_out'];

const FIND_BY_KEY_SQL = `
  SELECT a.id, a.title, a.body, a.priority, a.channels, a.target
  FROM idempotency_keys AS k
  JOIN alerts AS a
    ON a.id = k.alert_id
   AND a.tenant_id = k.tenant_id
  WHERE k.tenant_id = $1 AND k.key = $2`;

const INSERT_ALERT_ON_CONFLICT_SQL = `
  INSERT INTO alerts
    (tenant_id, created_by, title, body, priority, channels, target, idempotency_key)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id`;

async function findByKey(client, tenantId, key) {
  const result = await client.query(FIND_BY_KEY_SQL, [tenantId, key]);
  return result.rows[0];
}

function equivalent(existing, input) {
  try {
    assert.deepStrictEqual(
      {
        title: existing.title,
        body: existing.body,
        priority: existing.priority,
        channels: existing.channels,
        target: existing.target,
      },
      {
        title: input.title,
        body: input.body,
        priority: input.priority,
        channels: input.channels,
        target: input.target,
      }
    );
    return true;
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') return false;
    throw error;
  }
}

function replayOrConflict(existing, input) {
  if (!existing || !equivalent(existing, input)) {
    throw new AppError(
      409,
      'idempotency_key_reused',
      'Idempotency key was already used for a different request'
    );
  }
  return {
    alertId: existing.id,
    idempotencyKey: input.idempotencyKey,
    replayed: true,
    created: false,
  };
}

async function acceptAlert({ db, metrics, auth, input }) {
  const result = await db.withTenant(auth.tenantId, async (client) => {
    const existing = await findByKey(client, auth.tenantId, input.idempotencyKey);
    if (existing) return replayOrConflict(existing, input);

    const inserted = await client.query(INSERT_ALERT_ON_CONFLICT_SQL, [
      auth.tenantId,
      auth.userId,
      input.title,
      input.body,
      input.priority,
      input.channels,
      JSON.stringify(input.target),
      input.idempotencyKey,
    ]);
    if (inserted.rows.length === 0) {
      return replayOrConflict(
        await findByKey(client, auth.tenantId, input.idempotencyKey),
        input
      );
    }

    const alertId = inserted.rows[0].id;
    const eventId = randomUUID();
    await client.query(
      'INSERT INTO idempotency_keys (key, tenant_id, alert_id) VALUES ($1, $2, $3)',
      [input.idempotencyKey, auth.tenantId, alertId]
    );
    const payload = { eventId, alertId, tenantId: auth.tenantId };
    await client.query(
      `INSERT INTO alert_outbox (id, tenant_id, alert_id, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [eventId, auth.tenantId, alertId, JSON.stringify(payload)]
    );
    return {
      alertId,
      idempotencyKey: input.idempotencyKey,
      replayed: false,
      created: true,
    };
  });

  if (result.created) metrics.intakeAcceptedTotal.inc({ tenant_id: auth.tenantId });
  return {
    alertId: result.alertId,
    idempotencyKey: result.idempotencyKey,
    replayed: result.replayed,
  };
}

function mapAlert(row, detail = false) {
  const result = {
    id: row.id,
    title: row.title,
    priority: row.priority,
    status: row.status,
    channels: row.channels,
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at,
  };
  if (detail) {
    result.body = row.body;
    result.target = row.target;
    return {
      id: result.id,
      title: result.title,
      body: result.body,
      priority: result.priority,
      channels: result.channels,
      target: result.target,
      status: result.status,
      acceptedAt: result.acceptedAt,
      completedAt: result.completedAt,
    };
  }
  return result;
}

async function listAlerts({ db, auth }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, title, priority, status, channels, accepted_at, completed_at
       FROM alerts WHERE tenant_id = $1 ORDER BY accepted_at DESC, id DESC`,
      [auth.tenantId]
    );
    return result.rows.map((row) => mapAlert(row));
  });
}

async function findAlert(client, tenantId, alertId) {
  const result = await client.query(
    `SELECT id, title, body, priority, channels, target, status, accepted_at, completed_at
     FROM alerts WHERE tenant_id = $1 AND id = $2`,
    [tenantId, alertId]
  );
  if (!result.rows[0]) throw new AppError(404, 'not_found', 'Alert not found');
  return result.rows[0];
}

async function getAlertDetail({ db, auth, alertId }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const alert = await findAlert(client, auth.tenantId, alertId);
    const counts = await client.query(
      `SELECT status, count(*) AS count FROM deliveries
       WHERE tenant_id = $1 AND alert_id = $2 GROUP BY status`,
      [auth.tenantId, alertId]
    );
    const rank = new Map(STATUS_ORDER.map((status, index) => [status, index]));
    const deliveryCounts = counts.rows
      .map(({ status, count }) => ({ status, count: Number(count) }))
      .sort((left, right) => rank.get(left.status) - rank.get(right.status));
    return { alert: mapAlert(alert, true), deliveryCounts };
  });
}

async function listDeliveries({ db, auth, alertId }) {
  return db.withTenant(auth.tenantId, async (client) => {
    await findAlert(client, auth.tenantId, alertId);
    const result = await client.query(
      `SELECT d.id, d.channel, d.status, d.attempt_count, d.updated_at,
              d.delivered_at, r.name AS recipient_name
       FROM deliveries AS d
       JOIN recipients AS r
         ON r.id = d.recipient_id AND r.tenant_id = d.tenant_id
       WHERE d.tenant_id = $1 AND d.alert_id = $2
       ORDER BY r.name ASC, d.channel ASC, d.id ASC`,
      [auth.tenantId, alertId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      updatedAt: row.updated_at,
      deliveredAt: row.delivered_at,
      recipientName: row.recipient_name,
    }));
  });
}

function createAlertsRouter({ db, metrics }) {
  const router = express.Router();
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = parseAlertRequest({
        body: req.body,
        idempotencyKey: req.get('Idempotency-Key'),
      });
      const result = await acceptAlert({ db, metrics, auth: req.auth, input });
      req.log = req.log.child({ alert_id: result.alertId });
      res.status(202).json(result);
    })
  );
  router.get('/', asyncHandler(async (req, res) => {
    res.json(await listAlerts({ db, auth: req.auth }));
  }));
  router.get('/:id/deliveries', asyncHandler(async (req, res) => {
    const alertId = require('./schemas').parseUuidParam(req.params.id, 'id');
    res.json(await listDeliveries({ db, auth: req.auth, alertId }));
  }));
  router.get('/:id', asyncHandler(async (req, res) => {
    const alertId = require('./schemas').parseUuidParam(req.params.id, 'id');
    res.json(await getAlertDetail({ db, auth: req.auth, alertId }));
  }));
  return router;
}

module.exports = {
  acceptAlert,
  createAlertsRouter,
  getAlertDetail,
  listAlerts,
  listDeliveries,
};
