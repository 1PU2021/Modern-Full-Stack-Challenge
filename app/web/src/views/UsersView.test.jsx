import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsersView } from './UsersView';

function makeApi(overrides = {}) {
  return {
    listUsers: vi.fn().mockResolvedValue([
      { id: 'u1', email: 'admin@demo-county.test', role: 'tenant_admin', createdAt: '2026-01-01T00:00:00Z' },
    ]),
    createUser: vi.fn().mockResolvedValue({ id: 'u2', email: 'new-op@demo-county.test', role: 'operator', createdAt: '2026-01-02T00:00:00Z' }),
    ...overrides,
  };
}

describe('UsersView', () => {
  afterEach(cleanup);

  it('lists existing tenant users', async () => {
    const api = makeApi();
    render(<UsersView api={api} />);
    await waitFor(() => expect(screen.getByText('admin@demo-county.test')).toBeInTheDocument());
    expect(within(screen.getByRole('table')).getByText('tenant_admin')).toBeInTheDocument();
  });

  it('creates a new user and refreshes the list', async () => {
    const api = makeApi();
    render(<UsersView api={api} />);
    await waitFor(() => expect(screen.getByText('admin@demo-county.test')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new-op@demo-county.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'demo-only-change-me' } });
    fireEvent.change(screen.getByLabelText(/role/i), { target: { value: 'operator' } });
    fireEvent.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() => expect(api.createUser).toHaveBeenCalledWith({ email: 'new-op@demo-county.test', password: 'demo-only-change-me', role: 'operator' }));
    expect(api.listUsers).toHaveBeenCalledTimes(2);
  });

  it('shows a create error, e.g. a duplicate email', async () => {
    const api = makeApi({ createUser: vi.fn().mockRejectedValue(Object.assign(new Error('A user with this email already exists'), { status: 409 })) });
    render(<UsersView api={api} />);
    await waitFor(() => expect(screen.getByText('admin@demo-county.test')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'admin@demo-county.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'demo-only-change-me' } });
    fireEvent.click(screen.getByRole('button', { name: /create user/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
  });
});
