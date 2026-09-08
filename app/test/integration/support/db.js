'use strict';

const { Client } = require('pg');
const { runner } = require('node-pg-migrate');
const path = require('node:path');
const { loadConfig } = require('../../../src/shared/config');

async function ensureMigrated() {
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await runner({
      dbClient: client,
      dir: path.join(__dirname, '..', '..', '..', 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      logger: { info: () => {}, warn: console.warn, error: console.error },
    });
  } finally {
    await client.end();
  }
}

async function migrateTo(count) {
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await runner({
      dbClient: client,
      dir: path.join(__dirname, '..', '..', '..', 'migrations'),
      direction: count < 0 ? 'down' : 'up',
      count: Math.abs(count),
      migrationsTable: 'pgmigrations',
      logger: { info: () => {}, warn: console.warn, error: console.error },
    });
  } finally {
    await client.end();
  }
}

async function withSuperuserClient(fn) {
  const config = loadConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function appUserConnectionString(databaseUrl) {
  const url = new URL(databaseUrl);
  url.username = 'app_user';
  url.password = 'app_user';
  return url.toString();
}

async function withAppUserClient(fn) {
  const config = loadConfig();
  const client = new Client({ connectionString: appUserConnectionString(config.databaseUrl) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

module.exports = {
  ensureMigrated,
  migrateTo,
  withSuperuserClient,
  withAppUserClient,
  appUserConnectionString,
};
