import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('App authentication shell', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows login without a session and restores authenticated navigation from session storage', () => {
    const { unmount } = render(<App />);
    expect(screen.getByRole('heading', { name: /demo login/i })).toBeInTheDocument();
    unmount();
    sessionStorage.setItem('demo-token', 'stored-token');
    render(<App />);
    expect(screen.getByRole('link', { name: 'Compose' })).toBeInTheDocument();
  });

  it('logout clears the session and returns to login', () => {
    sessionStorage.setItem('demo-token', 'stored-token');
    sessionStorage.setItem('demo-tenant-slug', 'demo-county');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    expect(sessionStorage.getItem('demo-token')).toBeNull();
    expect(sessionStorage.getItem('demo-tenant-slug')).toBeNull();
    expect(screen.getByRole('heading', { name: /demo login/i })).toBeInTheDocument();
  });

  it('restores the tenant slug alongside the token from session storage', () => {
    sessionStorage.setItem('demo-token', 'stored-token');
    sessionStorage.setItem('demo-tenant-slug', 'demo-school');
    render(<App />);
    expect(sessionStorage.getItem('demo-tenant-slug')).toBe('demo-school');
  });

  it('shows a tenant_admin\'s full nav (Recipients, Groups, Team) when the role is restored from session storage', () => {
    sessionStorage.setItem('demo-token', 'stored-token');
    sessionStorage.setItem('demo-tenant-slug', 'demo-county');
    sessionStorage.setItem('demo-role', 'tenant_admin');
    render(<App />);
    expect(screen.getByRole('link', { name: 'Recipients' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Team' })).toBeInTheDocument();
  });

  it('an operator\'s restored session does not show admin-only nav links', () => {
    sessionStorage.setItem('demo-token', 'stored-token');
    sessionStorage.setItem('demo-tenant-slug', 'demo-county');
    sessionStorage.setItem('demo-role', 'operator');
    render(<App />);
    expect(screen.queryByRole('link', { name: 'Recipients' })).not.toBeInTheDocument();
  });

  it('clicking "Platform admin sign in" switches to the platform login, and back returns to tenant login', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /platform admin sign in/i }));
    expect(screen.getByRole('heading', { name: /platform admin login/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back to tenant login/i }));
    expect(screen.getByRole('heading', { name: /demo login/i })).toBeInTheDocument();
  });

  it('restores a platform session from session storage and shows only the Tenants nav', () => {
    sessionStorage.setItem('demo-platform-token', 'stored-platform-token');
    render(<App />);
    expect(screen.getByRole('link', { name: 'Tenants' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Compose' })).not.toBeInTheDocument();
  });

  it('platform logout clears only the platform session and returns to tenant login', () => {
    sessionStorage.setItem('demo-platform-token', 'stored-platform-token');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    expect(sessionStorage.getItem('demo-platform-token')).toBeNull();
    expect(screen.getByRole('heading', { name: /demo login/i })).toBeInTheDocument();
  });

  it('a stored tenant session and a stored platform session are independent -- platform wins when both are present, and each carries its own token', () => {
    sessionStorage.setItem('demo-token', 'stored-tenant-token');
    sessionStorage.setItem('demo-tenant-slug', 'demo-county');
    sessionStorage.setItem('demo-role', 'tenant_admin');
    sessionStorage.setItem('demo-platform-token', 'stored-platform-token');
    render(<App />);
    expect(screen.getByRole('link', { name: 'Tenants' })).toBeInTheDocument();
    // The tenant session is untouched underneath -- logging out of platform must not have torn it down.
    expect(sessionStorage.getItem('demo-token')).toBe('stored-tenant-token');
  });

  it('enters impersonation, shows a persistent banner, and exits back to the preserved platform session', async () => {
    sessionStorage.setItem('demo-platform-token', 'stored-platform-token');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/platform/tenants') return { ok: true, status: 200, json: async () => ([
        { id: 't1', slug: 'demo-county', name: 'Demo County', tenantType: 'county_em', active: true },
      ]) };
      if (url === '/api/platform/tenants/t1/impersonate') return {
        ok: true, status: 200,
        json: async () => ({ token: 'impersonation-token', role: 'tenant_admin', tenant: { id: 't1', slug: 'demo-county', name: 'Demo County' } }),
      };
      return { ok: true, status: 200, json: async () => [] };
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /act as tenant/i }));
    expect(await screen.findByText(/acting as demo county as platform administrator/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Recipients' })).toBeInTheDocument();
    expect(sessionStorage.getItem('demo-platform-token')).toBe('stored-platform-token');
    expect(sessionStorage.getItem('demo-token')).toBe('impersonation-token');

    fireEvent.click(screen.getByRole('button', { name: /exit impersonation/i }));
    expect(await screen.findByRole('heading', { name: 'Tenants' })).toBeInTheDocument();
    expect(sessionStorage.getItem('demo-platform-token')).toBe('stored-platform-token');
    expect(sessionStorage.getItem('demo-token')).toBeNull();
    expect(sessionStorage.getItem('demo-impersonation')).toBeNull();
  });

  it('direct tenant users do not see the impersonation banner', () => {
    sessionStorage.setItem('demo-token', 'direct-token');
    sessionStorage.setItem('demo-tenant-slug', 'demo-county');
    sessionStorage.setItem('demo-role', 'tenant_admin');
    render(<App />);
    expect(screen.queryByRole('button', { name: /exit impersonation/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/acting as .* platform administrator/i)).not.toBeInTheDocument();
  });
});
