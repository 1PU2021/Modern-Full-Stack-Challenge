import { useState } from 'react';

export function LoginView({ api, onLogin, onShowPlatformLogin }) {
  const [email, setEmail] = useState('admin@demo-county.test');
  const [password, setPassword] = useState('demo-only-change-me');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login({ email, password });
      onLogin(result.token, result.tenant.slug, result.role);
    } catch (loginError) {
      setError(loginError);
    } finally {
      setBusy(false);
    }
  };

  return <main className="login-page"><section className="card login-card">
    <span className="eyebrow dark">Critical Notifications demo console</span>
    <h1>Demo login</h1>
    <p>Sign in with your tenant user email and password. These credentials are for local demonstration only.</p>
    <form onSubmit={submit}>
      <label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p className="error" role="alert">{error.message}</p>}
    </form>
    {onShowPlatformLogin && <button type="button" onClick={onShowPlatformLogin}>Platform admin sign in</button>}
  </section></main>;
}
