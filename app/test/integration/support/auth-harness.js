'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

function createAuthHarness({ jwtSecret, db }) {
  const app = express();

  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }
    try {
      req.auth = jwt.verify(token, jwtSecret);
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }
    return next();
  });

  app.get('/api/v1/alerts/:id', async (req, res) => {
    const tenantId = req.auth.tenant_id;
    const result = await db.withTenant(tenantId, (client) =>
      client.query('SELECT id FROM alerts WHERE id = $1', [req.params.id])
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }
    return res.status(200).json({ id: result.rows[0].id });
  });

  return app;
}

function signToken({ jwtSecret, tenantId, userId }) {
  return jwt.sign({ tenant_id: tenantId, sub: userId }, jwtSecret);
}

module.exports = { createAuthHarness, signToken };
