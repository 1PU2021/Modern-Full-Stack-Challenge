import { describe, expect, it } from 'vitest';
import { getApiBaseUrl } from './config';

describe('getApiBaseUrl', () => {
  it('defaults to the Vite proxied API path', () => {
    expect(getApiBaseUrl({})).toBe('/api');
  });

  it('honors an explicit API base URL', () => {
    expect(getApiBaseUrl({ VITE_API_BASE_URL: 'http://localhost:3000/api' })).toBe('http://localhost:3000/api');
  });
});
