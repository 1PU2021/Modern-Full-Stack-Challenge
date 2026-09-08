'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGeocoder, createThrottle, GeocodeError } = require('./geocoder');

const ADDRESS = {
  addressLine1: '123 Main St', city: 'Rochester', state: 'IN', postalCode: '46975', country: 'US',
};

test('createThrottle enforces the minimum interval between calls', async () => {
  let clock = 0;
  const sleeps = [];
  const throttle = createThrottle(1000, {
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });

  await throttle(); // first call: nothing to wait for
  clock += 100; // only 100ms elapsed since the first call
  await throttle(); // must wait the remaining 900ms

  assert.deepEqual(sleeps, [900]);
});

test('createThrottle does not wait if the interval has already elapsed', async () => {
  let clock = 0;
  const sleeps = [];
  const throttle = createThrottle(1000, {
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });

  await throttle();
  clock += 5000; // plenty of time has passed
  await throttle();

  assert.deepEqual(sleeps, []);
});

test('the disabled ("none") provider always rejects with a clear, non-configured error', async () => {
  const geocoder = createGeocoder({ provider: 'none' });
  await assert.rejects(
    () => geocoder.geocode(ADDRESS),
    (error) => {
      assert.ok(error instanceof GeocodeError);
      assert.equal(error.code, 'not_configured');
      assert.match(error.message, /not configured/i);
      return true;
    }
  );
});

test('createGeocoder defaults to the disabled provider when none is specified', async () => {
  const geocoder = createGeocoder();
  await assert.rejects(() => geocoder.geocode(ADDRESS));
});

test('nominatim geocoder requires a User-Agent at construction time', () => {
  assert.throws(() => createGeocoder({ provider: 'nominatim' }), /GEOCODER_USER_AGENT/);
});

test('nominatim geocoder parses a successful result and passes the throttle + User-Agent through', async () => {
  const calls = [];
  const geocoder = createGeocoder({
    provider: 'nominatim',
    userAgent: 'critical-notifications-demo (ops@example.test)',
    throttle: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => [{ lat: '41.0645', lon: '-86.2183', display_name: 'Rochester, IN 46975, USA' }],
      };
    },
  });

  const result = await geocoder.geocode(ADDRESS);
  assert.deepEqual(result, { latitude: 41.0645, longitude: -86.2183, formattedAddress: 'Rochester, IN 46975, USA' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /nominatim\.openstreetmap\.org\/search/);
  assert.match(calls[0].url, /q=123%20Main%20St%2C%20Rochester%2C%20IN%2C%2046975%2C%20US/);
  assert.equal(calls[0].options.headers['User-Agent'], 'critical-notifications-demo (ops@example.test)');
});

test('nominatim geocoder throws a not_found GeocodeError on an empty result set', async () => {
  const geocoder = createGeocoder({
    provider: 'nominatim',
    userAgent: 'test-agent',
    throttle: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });

  await assert.rejects(
    () => geocoder.geocode(ADDRESS),
    (error) => {
      assert.ok(error instanceof GeocodeError);
      assert.equal(error.code, 'not_found');
      return true;
    }
  );
});

test('nominatim geocoder throws a provider_error GeocodeError on a non-OK response', async () => {
  const geocoder = createGeocoder({
    provider: 'nominatim',
    userAgent: 'test-agent',
    throttle: async () => {},
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });

  await assert.rejects(
    () => geocoder.geocode(ADDRESS),
    (error) => {
      assert.ok(error instanceof GeocodeError);
      assert.equal(error.code, 'provider_error');
      return true;
    }
  );
});

test('nominatim geocoder throws a provider_error GeocodeError on a network failure', async () => {
  const geocoder = createGeocoder({
    provider: 'nominatim',
    userAgent: 'test-agent',
    throttle: async () => {},
    fetchImpl: async () => { throw new Error('offline'); },
  });

  await assert.rejects(
    () => geocoder.geocode(ADDRESS),
    (error) => {
      assert.ok(error instanceof GeocodeError);
      assert.equal(error.code, 'provider_error');
      return true;
    }
  );
});
