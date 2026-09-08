import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginView } from './LoginView';

describe('LoginView', () => {
  afterEach(cleanup);

  it('shows only email and password and establishes a session from derived tenant metadata', async () => {
    const api = { login: vi.fn().mockResolvedValue({
      token: 'issued-token', role: 'operator', tenant: { id: 't1', slug: 'demo-school', name: 'Demo School' },
    }) };
    const onLogin = vi.fn();
    render(<LoginView api={api} onLogin={onLogin} />);
    expect(screen.queryByLabelText(/tenant/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'admin@demo-school.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'demo-only-change-me' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('issued-token', 'demo-school', 'operator'));
    expect(api.login).toHaveBeenCalledWith({ email: 'admin@demo-school.test', password: 'demo-only-change-me' });
  });

  it('offers a link to the platform admin login when onShowPlatformLogin is provided', () => {
    const onShowPlatformLogin = vi.fn();
    render(<LoginView api={{}} onLogin={vi.fn()} onShowPlatformLogin={onShowPlatformLogin} />);
    fireEvent.click(screen.getByRole('button', { name: /platform admin/i }));
    expect(onShowPlatformLogin).toHaveBeenCalledOnce();
  });

  it('uses the tenant metadata returned for an arbitrary platform-created user', async () => {
    const api = { login: vi.fn().mockResolvedValue({
      token: 'issued-token', role: 'tenant_admin', tenant: { id: 't2', slug: 'playwright-county', name: 'Playwright County' },
    }) };
    const onLogin = vi.fn();
    render(<LoginView api={api} onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'admin@playwright-county.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'demo-only-change-me' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('issued-token', 'playwright-county', 'tenant_admin'));
    expect(api.login).toHaveBeenCalledWith({ email: 'admin@playwright-county.test', password: 'demo-only-change-me' });
  });
});
