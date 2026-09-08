'use strict';

const { createProviderPersonality } = require('./personality');
const { createStubApp } = require('./app');

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function startStubs(overrides = {}) {
  const listen = overrides.listen || ((app, port, callback) => app.listen(port, callback));
  const smsPersonality = overrides.smsPersonality || createProviderPersonality({ channel: 'sms' });
  const emailPersonality = overrides.emailPersonality || createProviderPersonality({ channel: 'email' });
  const smsApp = (overrides.createStubApp || createStubApp)({ channel: 'sms', personality: smsPersonality });
  const emailApp = (overrides.createStubApp || createStubApp)({ channel: 'email', personality: emailPersonality });
  const smsServer = listen(smsApp, overrides.smsPort || 4000);
  const emailServer = listen(emailApp, overrides.emailPort || 4001);
  return { smsServer, emailServer, close: async () => { await closeServer(smsServer); await closeServer(emailServer); } };
}

if (require.main === module) {
  try { startStubs(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { startStubs };
