'use strict';

const { Client } = require('pg');
const { loadConfig } = require('../src/shared/config');
const { issueJwt } = require('../src/shared/demo-auth');

function parseArgs(argv) {
  const result = { tenantSlug: 'demo-county', userEmail: 'admin@demo-county.test' };
  for (const arg of argv) {
    const match = /^(--tenant|--user)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Unknown option: ${arg}`);
    if (!match[2]) throw new Error(`${match[1]} requires a value`);
    if (match[1] === '--tenant') result.tenantSlug = match[2];
    else result.userEmail = match[2];
  }
  return result;
}

const createToken = issueJwt;

async function main(argv = process.argv.slice(2)) {
  const { tenantSlug, userEmail } = parseArgs(argv);
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT t.id AS tenant_id, u.id AS user_id
       FROM tenants AS t JOIN users AS u ON u.tenant_id = t.id
       WHERE t.slug = $1 AND u.email = $2`, [tenantSlug, userEmail]
    );
    if (!result.rows[0]) throw new Error('Seeded tenant/user not found; run npm run seed first');
    process.stdout.write(`${createToken({ tenantId: result.rows[0].tenant_id, userId: result.rows[0].user_id, secret: config.jwtSecret })}\n`);
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`Token generation failed: ${error.message}\n`); process.exitCode = 1; });

module.exports = { parseArgs, createToken, main };
