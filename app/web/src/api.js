import { getApiBaseUrl } from './config';

function makeIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readError(response, payload) {
  const error = payload?.error || {};
  return Object.assign(new Error(error.message || `Request failed (${response.status})`), {
    status: response.status,
    code: error.code || 'request_failed',
    details: error.details,
  });
}

export function createApi({ baseUrl = getApiBaseUrl(), fetchImpl = globalThis.fetch, getToken = () => '', onUnauthorized = () => {} } = {}) {
  async function request(path, options = {}, { authenticated = true } = {}) {
    const headers = { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers };
    const token = authenticated ? getToken() : '';
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${baseUrl}${path}`, { ...options, headers });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty response */ }
    if (!response.ok) {
      if (authenticated && response.status === 401) onUnauthorized();
      throw await readError(response, payload);
    }
    return payload;
  }

  async function requestText(path, options = {}) {
    const headers = { ...options.headers };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${baseUrl}${path}`, { ...options, headers });
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { /* empty response */ }
      if (response.status === 401) onUnauthorized();
      throw await readError(response, payload);
    }
    return response.text();
  }

  return {
    login: (credentials) => request('/auth/login', {
      method: 'POST', body: JSON.stringify(credentials),
    }, { authenticated: false }),
    listAlerts: () => request('/v1/alerts'),
    getAlert: (id) => request(`/v1/alerts/${encodeURIComponent(id)}`),
    getDeliveries: (id) => request(`/v1/alerts/${encodeURIComponent(id)}/deliveries`),
    createAlert: (body, idempotencyKey = makeIdempotencyKey()) => request('/v1/alerts', {
      method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': idempotencyKey },
    }),

    listGroups: () => request('/v1/groups'),
    createGroup: (body) => request('/v1/groups', { method: 'POST', body: JSON.stringify(body) }),
    renameGroup: (id, body) => request(`/v1/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteGroup: (id) => request(`/v1/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getGroupMembers: (id) => request(`/v1/groups/${encodeURIComponent(id)}/members`),
    addGroupMember: (id, recipientId) => request(`/v1/groups/${encodeURIComponent(id)}/members`, {
      method: 'POST', body: JSON.stringify({ recipientId }),
    }),
    removeGroupMember: (id, recipientId) => request(`/v1/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(recipientId)}`, {
      method: 'DELETE',
    }),

    listRecipients: (includeInactive = false) => request(`/v1/recipients${includeInactive ? '?includeInactive=true' : ''}`),
    createRecipient: (body) => request('/v1/recipients', { method: 'POST', body: JSON.stringify(body) }),
    updateRecipient: (id, body) => request(`/v1/recipients/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deactivateRecipient: (id) => request(`/v1/recipients/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    importRecipients: (csv) => request('/v1/recipients/import', { method: 'POST', body: JSON.stringify({ csv }) }),
    exportRecipients: () => requestText('/v1/recipients/export'),

    listUsers: () => request('/v1/users'),
    createUser: (body) => request('/v1/users', { method: 'POST', body: JSON.stringify(body) }),
  };
}

// Entirely separate from createApi: platform-admin sessions use a
// different token, a different signing secret server-side, and a
// different path prefix (/api/platform/*) -- never the same api object as
// a tenant session, mirroring the backend's isolation.
export function createPlatformApi({ baseUrl = getApiBaseUrl(), fetchImpl = globalThis.fetch, getToken = () => '', onUnauthorized = () => {} } = {}) {
  async function request(path, options = {}, { authenticated = true } = {}) {
    const headers = { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers };
    const token = authenticated ? getToken() : '';
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${baseUrl}${path}`, { ...options, headers });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty response */ }
    if (!response.ok) {
      if (authenticated && response.status === 401) onUnauthorized();
      throw await readError(response, payload);
    }
    return payload;
  }

  return {
    login: (credentials) => request('/platform/auth/login', {
      method: 'POST', body: JSON.stringify(credentials),
    }, { authenticated: false }),
    listTenants: () => request('/platform/tenants'),
    createTenant: (body) => request('/platform/tenants', { method: 'POST', body: JSON.stringify(body) }),
    setTenantActive: (id, active) => request(`/platform/tenants/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ active }),
    }),
    impersonateTenant: (id) => request(`/platform/tenants/${encodeURIComponent(id)}/impersonate`, {
      method: 'POST',
    }),
  };
}

export { makeIdempotencyKey };
