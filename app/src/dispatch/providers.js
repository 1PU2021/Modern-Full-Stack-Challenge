'use strict';

const { setTimeout: setTimer, clearTimeout } = require('node:timers');
const { AbortController } = globalThis;

function classifyProviderResponse(response) {
  const status = Number(response.status);
  if (status >= 200 && status < 300) return { outcome: 'delivered', retryable: false, permanent: false };
  if (status === 429) return { outcome: 'rate_limited', retryable: true, permanent: false };
  if (status === 408 || status === 504) return { outcome: 'timed_out', retryable: true, permanent: false };
  if (status >= 500) return { outcome: 'failed', retryable: true, permanent: false };
  return { outcome: 'failed', retryable: false, permanent: true };
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function createProviderClient({ urls, fetchImpl = globalThis.fetch, timeoutMs = 25_000 }) {
  async function send(job, { abortSignal } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (abortSignal?.aborted) throw abortError();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const request = fetchImpl(urls[job.channel], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
        signal: controller.signal,
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => {
          controller.abort();
          const error = new Error('provider request timed out');
          error.name = 'ProviderTimeoutError';
          reject(error);
        }, timeoutMs);
      });
      const response = await Promise.race([request, timeout]);
      const classification = classifyProviderResponse(response);
      let text = '';
      try { text = (await response.text()).slice(0, 4096); } catch { /* bounded optional body */ }
      let parsed;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = { text }; }
      return { ...classification, response: parsed };
    } catch (error) {
      if (error.name === 'ProviderTimeoutError') {
        return { outcome: 'timed_out', retryable: true, permanent: false, response: { reason: 'timeout' } };
      }
      if (error.name === 'AbortError') throw error;
      return { outcome: 'failed', retryable: true, permanent: false, response: { reason: 'network_error' } };
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
    }
  }
  return { send };
}

module.exports = { classifyProviderResponse, createProviderClient };
