'use strict';

const { setTimeout: setTimer, clearTimeout } = require('node:timers');
const { AbortController } = globalThis;

class GeocodeError extends Error {
  constructor(message, { code = 'geocode_failed' } = {}) {
    super(message);
    this.name = 'GeocodeError';
    this.code = code; // 'not_found' | 'provider_error' | 'not_configured'
  }
}

function formatAddress(address) {
  return [
    address.addressLine1, address.addressLine2, address.city,
    address.state, address.postalCode, address.country,
  ].filter(Boolean).join(', ');
}

// Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
// caps the whole process at 1 request/second -- this throttle exists to make
// that hard limit structurally impossible to violate (e.g. during a CSV
// import geocoding many rows), not just documented and hoped for. `now`/
// `sleep` are injectable so the throttling logic itself can be unit tested
// without real waiting.
function createThrottle(minIntervalMs, { now = Date.now, sleep = (ms) => new Promise((resolve) => setTimer(resolve, ms)) } = {}) {
  let nextAvailableAt = 0;
  return async function throttle() {
    const current = now();
    const waitMs = Math.max(0, nextAvailableAt - current);
    nextAvailableAt = Math.max(current, nextAvailableAt) + minIntervalMs;
    if (waitMs > 0) await sleep(waitMs);
  };
}

const NOT_VERIFIED_MESSAGE = 'Could not verify this address. Check the address and try again.';
const PROVIDER_ERROR_MESSAGE = 'Could not reach the geocoding service. Try again shortly.';

function createNominatimGeocoder({
  fetchImpl = globalThis.fetch,
  userAgent,
  baseUrl = 'https://nominatim.openstreetmap.org',
  timeoutMs = 8_000,
  throttle = createThrottle(1_100),
} = {}) {
  if (!userAgent) {
    // Nominatim's usage policy requires a valid custom User-Agent (or HTTP
    // Referer) identifying the calling application -- fail loudly at
    // construction rather than sending unattributed requests that policy
    // forbids and that Nominatim may silently block anyway.
    throw new Error('GEOCODER_USER_AGENT is required when GEOCODER_PROVIDER=nominatim');
  }

  return {
    async geocode(address) {
      await throttle();
      const query = formatAddress(address);
      const url = `${baseUrl}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
      const controller = new AbortController();
      const timer = setTimer(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch {
        throw new GeocodeError(PROVIDER_ERROR_MESSAGE, { code: 'provider_error' });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new GeocodeError(PROVIDER_ERROR_MESSAGE, { code: 'provider_error' });
      }
      let results;
      try {
        results = await response.json();
      } catch {
        throw new GeocodeError(PROVIDER_ERROR_MESSAGE, { code: 'provider_error' });
      }
      if (!Array.isArray(results) || results.length === 0) {
        throw new GeocodeError(NOT_VERIFIED_MESSAGE, { code: 'not_found' });
      }
      const [best] = results;
      const latitude = Number(best.lat);
      const longitude = Number(best.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new GeocodeError(NOT_VERIFIED_MESSAGE, { code: 'not_found' });
      }
      return { latitude, longitude, formattedAddress: best.display_name };
    },
  };
}

// The safe default: no outbound network calls until an operator explicitly
// opts in via GEOCODER_PROVIDER=nominatim. Address entry still works end to
// end in the UI -- it just surfaces this as a clear validation error, which
// is what pushes a tenant admin toward the manual lat/lon fallback rather
// than silently pretending an address was verified.
function createDisabledGeocoder() {
  return {
    async geocode() {
      throw new GeocodeError(
        'Address geocoding is not configured for this environment. Enter coordinates manually under Advanced location, or ask an administrator to configure GEOCODER_PROVIDER.',
        { code: 'not_configured' }
      );
    },
  };
}

function createGeocoder({ provider = 'none', ...options } = {}) {
  if (provider === 'nominatim') return createNominatimGeocoder(options);
  return createDisabledGeocoder();
}

module.exports = { createGeocoder, createThrottle, GeocodeError };
