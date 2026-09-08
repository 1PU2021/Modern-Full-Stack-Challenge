import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TenantsView } from './TenantsView';

function makeApi(overrides = {}) {
  return {
    listTenants: vi.fn().mockResolvedValue([
      { id: 't1', slug: 'demo-county', name: 'Demo County', tenantType: 'county_em', active: true, createdAt: '2026-01-01T00:00:00Z' },
    ]),
    createTenant: vi.fn().mockResolvedValue({ tenant: { id: 't2', slug: 'new-tenant', name: 'New Tenant', tenantType: 'county_em', active: true }, adminEmail: 'admin@new-tenant.test' }),
    setTenantActive: vi.fn().mockResolvedValue({ id: 't1', active: false }),
    ...overrides,
  };
}

describe('TenantsView', () => {
  afterEach(cleanup);

  it('lists existing tenants', async () => {
    const api = makeApi();
    render(<TenantsView api={api} />);
    await waitFor(() => expect(screen.getByText('Demo County')).toBeInTheDocument());
    expect(screen.getByText('demo-county')).toBeInTheDocument();
    expect(api.listTenants).toHaveBeenCalledOnce();
  });

  it('offers impersonation only for active tenants', async () => {
    const api = makeApi({ listTenants: vi.fn().mockResolvedValue([
      { id: 'active', slug: 'active', name: 'Active Tenant', tenantType: 'county_em', active: true },
      { id: 'inactive', slug: 'inactive', name: 'Inactive Tenant', tenantType: 'county_em', active: false },
    ]) });
    const onImpersonate = vi.fn().mockResolvedValue();
    render(<TenantsView api={api} onImpersonate={onImpersonate} />);
    await screen.findByText('Active Tenant');
    const actions = screen.getAllByRole('button', { name: /act as tenant/i });
    expect(actions).toHaveLength(1);
    fireEvent.click(actions[0]);
    await waitFor(() => expect(onImpersonate).toHaveBeenCalledWith(expect.objectContaining({ id: 'active' })));
  });

  it('creates a tenant with its initial admin, then refreshes the list', async () => {
    const api = makeApi();
    render(<TenantsView api={api} />);
    await waitFor(() => expect(screen.getByText('Demo County')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/tenant name/i), { target: { value: 'New Tenant' } });
    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: 'new-tenant' } });
    fireEvent.change(screen.getByLabelText(/tenant type/i), { target: { value: 'county_em' } });
    fireEvent.change(screen.getByLabelText(/initial admin email/i), { target: { value: 'admin@new-tenant.test' } });
    fireEvent.change(screen.getByLabelText(/temporary password/i), { target: { value: 'demo-only-change-me' } });
    fireEvent.click(screen.getByRole('button', { name: /create tenant/i }));

    await waitFor(() => expect(api.createTenant).toHaveBeenCalledWith({
      name: 'New Tenant', slug: 'new-tenant', tenantType: 'county_em',
      adminEmail: 'admin@new-tenant.test', adminPassword: 'demo-only-change-me',
    }));
    expect(await screen.findByText(/created tenant "new tenant"/i)).toBeInTheDocument();
    expect(api.listTenants).toHaveBeenCalledTimes(2);
  });

  it('toggles a tenant active/disabled', async () => {
    const api = makeApi();
    render(<TenantsView api={api} />);
    await waitFor(() => expect(screen.getByText('Demo County')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /disable/i }));
    await waitFor(() => expect(api.setTenantActive).toHaveBeenCalledWith('t1', false));
  });

  it('shows a create error without crashing', async () => {
    const api = makeApi({ createTenant: vi.fn().mockRejectedValue(Object.assign(new Error('A tenant with this slug already exists'), { status: 409 })) });
    render(<TenantsView api={api} />);
    await waitFor(() => expect(screen.getByText('Demo County')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/tenant name/i), { target: { value: 'Dup' } });
    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: 'demo-county' } });
    fireEvent.change(screen.getByLabelText(/tenant type/i), { target: { value: 'county_em' } });
    fireEvent.change(screen.getByLabelText(/initial admin email/i), { target: { value: 'a@b.test' } });
    fireEvent.change(screen.getByLabelText(/temporary password/i), { target: { value: 'demo-only-change-me' } });
    fireEvent.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
  });
});
