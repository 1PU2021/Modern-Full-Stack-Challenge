'use strict';

const { parseStoredAlert, PermanentFanoutError } = require('./schemas');

function mapJobs(rows) {
  return rows.map((row) => ({
    deliveryId: row.id,
    alertId: row.alert_id,
    tenantId: row.tenant_id,
    recipientId: row.recipient_id,
    channel: row.channel,
  }));
}

async function resolveGroup(client, tenantId, groupId) {
  const result = await client.query(
    `SELECT gm.recipient_id
     FROM group_members AS gm
     JOIN recipients AS r
       ON r.id = gm.recipient_id AND r.tenant_id = gm.tenant_id
     WHERE gm.tenant_id = $1 AND gm.group_id = $2 AND r.deactivated_at IS NULL
     ORDER BY gm.recipient_id`,
    [tenantId, groupId]
  );
  return result.rows.map((row) => row.recipient_id);
}

async function resolvePolygon(client, tenantId, geojson) {
  const json = JSON.stringify(geojson);
  try {
    const validity = await client.query(
      `SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) AS valid`,
      [json]
    );
    if (!validity.rows[0]?.valid) {
      throw new PermanentFanoutError('invalid_geometry', 'Invalid alert geometry');
    }
    const result = await client.query(
      `SELECT id
       FROM recipients
       WHERE tenant_id = $1 AND location IS NOT NULL AND deactivated_at IS NULL
         AND ST_Contains(
           ST_SetSRID(ST_GeomFromGeoJSON($2), 4326),
           location::geometry
         )
       ORDER BY id`,
      [tenantId, json]
    );
    return result.rows.map((row) => row.id);
  } catch (error) {
    if (error instanceof PermanentFanoutError) throw error;
    if (['22P02', '22023', 'XX000'].includes(error.code)) {
      throw new PermanentFanoutError('invalid_geometry', 'Invalid alert geometry');
    }
    throw error;
  }
}

function createFanoutStore({ db }) {
  async function materialize(event) {
    return db.withTenant(event.tenantId, async (client) => {
      const selected = await client.query(
        `SELECT id, tenant_id, channels, target, status
         FROM alerts
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [event.tenantId, event.alertId]
      );
      if (!selected.rows[0]) {
        throw new PermanentFanoutError('alert_not_found', 'Alert not found');
      }
      const alert = parseStoredAlert(selected.rows[0]);
      if (alert.status === 'completed' || alert.status === 'failed') {
        return { state: alert.status, jobs: [] };
      }

      await client.query(
        `UPDATE alerts SET status = 'expanding'
         WHERE tenant_id = $1 AND id = $2`,
        [event.tenantId, event.alertId]
      );
      const recipientIds = alert.target.type === 'group'
        ? await resolveGroup(client, event.tenantId, alert.target.groupId)
        : await resolvePolygon(client, event.tenantId, alert.target.geojson);

      if (recipientIds.length > 0) {
        await client.query(
          `INSERT INTO deliveries (tenant_id, alert_id, recipient_id, channel)
           SELECT $1, $2, recipient_id, channel
           FROM unnest($3::uuid[]) AS recipient_id
           CROSS JOIN unnest($4::text[]) AS channel
           ON CONFLICT (alert_id, recipient_id, channel) DO NOTHING`,
          [event.tenantId, event.alertId, recipientIds, alert.channels]
        );
      }

      const deliveries = await client.query(
        `SELECT id, tenant_id, alert_id, recipient_id, channel
         FROM deliveries
         WHERE tenant_id = $1 AND alert_id = $2
         ORDER BY recipient_id, channel, id`,
        [event.tenantId, event.alertId]
      );
      if (deliveries.rows.length === 0) {
        await client.query(
          `UPDATE alerts SET status = 'completed', completed_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [event.tenantId, event.alertId]
        );
        return { state: 'completed', jobs: [] };
      }
      await client.query(
        `UPDATE alerts SET status = 'dispatching', completed_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [event.tenantId, event.alertId]
      );
      return { state: 'dispatching', jobs: mapJobs(deliveries.rows) };
    });
  }

  async function markFailed(event, reason) {
    void reason;
    return db.withTenant(event.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE alerts SET status = 'failed', completed_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status <> 'completed'`,
        [event.tenantId, event.alertId]
      );
      return result.rowCount === 1;
    });
  }

  return { markFailed, materialize };
}

module.exports = { createFanoutStore };
