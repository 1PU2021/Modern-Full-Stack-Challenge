import { useCallback, useEffect, useState } from 'react';

const EMPTY_FORM = { email: '', password: 'demo-only-change-me', role: 'operator' };

// List + create only, per project decision -- edit, deactivate, and
// password reset for tenant users are documented follow-up work.
export function UsersView({ api }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      setUsers(await api.listUsers());
    } catch (error) {
      setListError(error);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setCreateError(null);
    try {
      await api.createUser(form);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (error) {
      setCreateError(error);
    } finally {
      setBusy(false);
    }
  };

  return <section className="card">
    <h1>Team</h1>
    {loading && <p>Loading users…</p>}
    {listError && <p className="error">Unable to load users: {listError.message}</p>}
    {!loading && !listError && <table>
      <thead><tr><th>Email</th><th>Role</th></tr></thead>
      <tbody>{users.map((user) => <tr key={user.id}><td>{user.email}</td><td>{user.role}</td></tr>)}</tbody>
    </table>}

    <h2>Add a user</h2>
    <form onSubmit={submit}>
      <label>Email<input type="email" required value={form.email} onChange={(e) => update('email', e.target.value)} /></label>
      <label>Password<input required minLength={8} value={form.password} onChange={(e) => update('password', e.target.value)} /></label>
      <label>Role<select value={form.role} onChange={(e) => update('role', e.target.value)}>
        <option value="operator">operator</option>
        <option value="tenant_admin">tenant_admin</option>
      </select></label>
      <button disabled={busy} type="submit">{busy ? 'Creating…' : 'Create user'}</button>
      {createError && <p className="error" role="alert">{createError.message}</p>}
    </form>
  </section>;
}
