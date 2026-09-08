import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformLoginView } from './PlatformLoginView';

describe('PlatformLoginView', () => {
  afterEach(cleanup);

  it('submits platform admin credentials and returns the token', async () => {
    const api = { login: vi.fn().mockResolvedValue({ token: 'platform-token' }) };
    const onLogin = vi.fn();
    render(<PlatformLoginView api={api} onLogin={onLogin} onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'platform-admin@critical-demo.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'demo-only-change-me' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('platform-token'));
    expect(api.login).toHaveBeenCalledWith({ email: 'platform-admin@critical-demo.test', password: 'demo-only-change-me' });
  });

  it('shows a login error and lets the user go back to the tenant login', async () => {
    const api = { login: vi.fn().mockRejectedValue(Object.assign(new Error('Invalid email or password'), { status: 401 })) };
    const onBack = vi.fn();
    render(<PlatformLoginView api={api} onLogin={vi.fn()} onBack={onBack} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'wrong@example.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid email or password/i));

    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
