import { describe, expect, it, vi } from 'vitest';
import { createApi, createPlatformApi } from './api';

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

describe('createApi', () => {
  it('logs in without bearer auth and returns the issued token', async () => {
    const payload = { token: 'issued-token', role: 'tenant_admin', tenant: { id: 't1', slug: 'demo-county', name: 'Demo County' } };
    const fetchImpl = vi.fn().mockResolvedValue(response(payload));
    const api = createApi({ baseUrl: '/api', fetchImpl, getToken: () => 'old-token' });
    await expect(api.login({ email: 'admin@demo-county.test', password: 'password' })).resolves.toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'admin@demo-county.test', password: 'password' }),
      headers: expect.not.objectContaining({ authorization: expect.anything() }),
    }));
  });

  it('adds bearer auth and serializes alert creation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ alertId: 'a1' }, true, 202));
    const api = createApi({ baseUrl: '/api', fetchImpl, getToken: () => 'dev-token' });
    await api.createAlert({ title: 'Storm', channels: ['sms'] });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/alerts', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer dev-token', 'Idempotency-Key': expect.any(String) }),
    }));
  });

  it('preserves structured backend errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: 'validation_failed', message: 'bad', details: [{ path: 'title' }] } }, false, 400));
    const api = createApi({ fetchImpl, getToken: () => 'token' });
    await expect(api.listGroups()).rejects.toMatchObject({ status: 400, code: 'validation_failed', details: [{ path: 'title' }] });
  });

  it('notifies the app when a protected request returns 401', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: 'invalid_token' } }, false, 401));
    const api = createApi({ fetchImpl, getToken: () => 'expired', onUnauthorized });
    await expect(api.listGroups()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('sends recipient CRUD requests with the right method, path, and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: 'r1' }, true, 201));
    const api = createApi({ baseUrl: '/api', fetchImpl, getToken: () => 'token' });

    await api.createRecipient({ name: 'Jamie' });
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/recipients', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Jamie' }) }));

    await api.updateRecipient('r1', { name: 'Jamie R.' });
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/recipients/r1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Jamie R.' }) }));

    await api.deactivateRecipient('r1');
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/recipients/r1', expect.objectContaining({ method: 'DELETE' }));

    await api.listRecipients();
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/recipients', expect.anything());
    await api.listRecipients(true);
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/recipients?includeInactive=true', expect.anything());
  });

  it('imports a CSV as JSON and exports as raw text, both authenticated', async () => {
    const importFetch = vi.fn().mockResolvedValue(response({ imported: 1, skipped: 0, failed: 0, errors: [] }));
    const importApi = createApi({ baseUrl: '/api', fetchImpl: importFetch, getToken: () => 'token' });
    await importApi.importRecipients('name\nJamie');
    expect(importFetch).toHaveBeenCalledWith('/api/v1/recipients/import', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ csv: 'name\nJamie' }),
    }));

    const exportFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, async text() { return 'name,email\nJamie,jamie@example.test'; } });
    const exportApi = createApi({ baseUrl: '/api', fetchImpl: exportFetch, getToken: () => 'token' });
    await expect(exportApi.exportRecipients()).resolves.toBe('name,email\nJamie,jamie@example.test');
    expect(exportFetch).toHaveBeenCalledWith('/api/v1/recipients/export', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer token' }),
    }));
  });

  it('exportRecipients surfaces a structured error and calls onUnauthorized on 401, like other requests', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 401, async json() { return { error: { code: 'invalid_token', message: 'expired' } }; },
    });
    const api = createApi({ baseUrl: '/api', fetchImpl, getToken: () => 'token', onUnauthorized });
    await expect(api.exportRecipients()).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('sends group CRUD and membership requests correctly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    const api = createApi({ baseUrl: '/api', fetchImpl, getToken: () => 'token' });

    await api.createGroup({ name: 'Field Team' });
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/groups', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Field Team' }) }));

    await api.renameGroup('g1', { name: 'Field Team East' });
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/groups/g1', expect.objectContaining({ method: 'PATCH' }));

    await api.deleteGroup('g1');
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/groups/g1', expect.objectContaining({ method: 'DELETE' }));

    await api.getGroupMembers('g1');
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/groups/g1/members', expect.anything());

    await api.addGroupMember('g1', 'r1');
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/groups/g1/members', expect.objectContaining({ method: 'POST', body: JSON.stringify({ recipientId: 'r1' }) }));

    await api.removeGroupMember('g1', 'r1');
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/groups/g1/members/r1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('sends user list/create requests correctly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    const api = createApi({ baseUrl: '/api', fetchImpl, getToken: () => 'token' });

    await api.listUsers();
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/users', expect.anything());

    await api.createUser({ email: 'new@example.test', password: 'demo-only-change-me', role: 'operator' });
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/v1/users', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: 'new@example.test', password: 'demo-only-change-me', role: 'operator' }),
    }));
  });
});

describe('createPlatformApi', () => {
  it('logs in without bearer auth against the platform login path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ token: 'platform-token' }));
    const api = createPlatformApi({ baseUrl: '/api', fetchImpl, getToken: () => 'stale-tenant-token' });
    await expect(api.login({ email: 'platform-admin@critical-demo.test', password: 'x' })).resolves.toEqual({ token: 'platform-token' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/platform/auth/login', expect.objectContaining({
      headers: expect.not.objectContaining({ authorization: expect.anything() }),
    }));
  });

  it('lists, creates, and disables tenants against /api/platform/tenants', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    const api = createPlatformApi({ baseUrl: '/api', fetchImpl, getToken: () => 'platform-token' });

    await api.listTenants();
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/platform/tenants', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer platform-token' }),
    }));

    await api.createTenant({ name: 'New Tenant', slug: 'new-tenant', tenantType: 'county_em', adminEmail: 'a@new-tenant.test', adminPassword: 'demo-only-change-me' });
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/platform/tenants', expect.objectContaining({ method: 'POST' }));

    await api.setTenantActive('t1', false);
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/platform/tenants/t1', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ active: false }),
    }));
  });

  it('requests a tenant impersonation session with the platform token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ token: 'tenant-token', role: 'tenant_admin', tenant: { id: 't1', slug: 'demo-county', name: 'Demo County' } }),
    });
    const api = createPlatformApi({ fetchImpl, getToken: () => 'platform-token', baseUrl: '/api' });
    await api.impersonateTenant('t1');
    expect(fetchImpl).toHaveBeenCalledWith('/api/platform/tenants/t1/impersonate', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer platform-token' }),
    }));
  });

  it('is a fully separate token/error space from the tenant api', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: 'invalid_token' } }, false, 401));
    const api = createPlatformApi({ baseUrl: '/api', fetchImpl, getToken: () => 'expired-platform-token', onUnauthorized });
    await expect(api.listTenants()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
