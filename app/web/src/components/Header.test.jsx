import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';

function renderHeader(role) {
  return render(<MemoryRouter><Header onLogout={vi.fn()} role={role} /></MemoryRouter>);
}

describe('Header', () => {
  afterEach(cleanup);

  it('shows only Compose and Alerts for an operator', () => {
    renderHeader('operator');
    expect(screen.getByRole('link', { name: 'Compose' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Alerts' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Recipients' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Groups' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
  });

  it('shows Compose, Alerts, Recipients, Groups, and Team for a tenant_admin', () => {
    renderHeader('tenant_admin');
    for (const label of ['Compose', 'Alerts', 'Recipients', 'Groups', 'Team']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('shows only Tenants for a platform_admin', () => {
    renderHeader('platform_admin');
    expect(screen.getByRole('link', { name: 'Tenants' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Compose' })).not.toBeInTheDocument();
  });

  it('falls back to the operator nav for an unrecognized or missing role', () => {
    renderHeader(undefined);
    expect(screen.getByRole('link', { name: 'Compose' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Recipients' })).not.toBeInTheDocument();
  });
});
