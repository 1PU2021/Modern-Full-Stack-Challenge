import { useState } from 'react';

export function PlatformLoginView({ api, onLogin, onBack }) {
  const [email, setEmail] = useState('platform-admin@critical-demo.test');
  const [password, setPassword] = useState('demo-only-change-me');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login({ email, password });
      onLogin(result.token);
    } catch (loginError) {
      setError(loginError);
    } finally {
      setBusy(false);
    }
  };

  return <main className="login-page"><section className="card login-card">
    <span className="eyebrow dark">Critical Notifications demo console</span>
    <h1>Platform admin login</h1>
    <p>Manages tenants across the whole platform. For local demonstration only.</p>
    <form onSubmit={submit}>
      <label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p className="error" role="alert">{error.message}</p>}
    </form>
    <button type="button" onClick={onBack}>Back to tenant login</button>
  </section></main>;
}
