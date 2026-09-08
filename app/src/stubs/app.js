'use strict';

const express = require('express');

function createStubApp({ channel, personality }) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', channel }));
  app.post(`/${channel}/send`, async (req, res, next) => {
    try {
      const result = await personality.handle({ body: req.body }, { abortSignal: req.signal });
      if (result.headers) res.set(result.headers);
      return res.status(result.status).json(result.body);
    } catch (error) { return next(error); }
  });
  app.use((error, req, res, next) => { void next; res.status(500).json({ error: 'stub_error' }); });
  return app;
}

module.exports = { createStubApp };
