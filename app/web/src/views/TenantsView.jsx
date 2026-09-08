import { useCallback, useEffect, useState } from 'react';

const TENANT_TYPES = ['county_em', 'school_district', 'state_agency', 'hospital_system', 'dispatch_center'];

const EMPTY_FORM = {
  name: '', slug: '', tenantType: 'county_em', adminEmail: '', adminPassword: 'demo-only-change-me',
};

export function TenantsView({ api, onImpersonate }) {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [created, setCreated] = useState(null);
  const [actionError, setActionError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      setTenants(await api.listTenants());
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
    setCreated(null);
    try {
      const result = await api.createTenant(form);
      setCreated(result);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (error) {
      setCreateError(error);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (tenant) => {
    await api.setTenantActive(tenant.id, !tenant.active);
    await refresh();
  };

  const impersonate = async (tenant) => {
    setActionError(null);
    try {
      await onImpersonate(tenant);
    } catch (error) {
      setActionError(error);
    }
  };

  return <section className="card">
    <h1>Tenants</h1>
    {loading && <p>Loading tenants…</p>}
    {listError && <p className="error">Unable to load tenants: {listError.message}</p>}
    {!loading && !listError && <table>
      <thead><tr><th>Name</th><th>Slug</th><th>Type</th><th>Status</th><th /></tr></thead>
      <tbody>{tenants.map((tenant) => <tr key={tenant.id}>
        <td>{tenant.name}</td>
        <td>{tenant.slug}</td>
        <td>{tenant.tenantType}</td>
        <td><span className="status">{tenant.active ? 'active' : 'disabled'}</span></td>
        <td><div className="inline-controls">
          <button type="button" onClick={() => toggleActive(tenant)}>{tenant.active ? 'Disable' : 'Enable'}</button>
          {tenant.active && onImpersonate && <button type="button" onClick={() => impersonate(tenant)}>Act as Tenant</button>}
        </div></td>
      </tr>)}</tbody>
    </table>}
    {actionError && <p className="error" role="alert">Unable to impersonate tenant: {actionError.message}</p>}

    <h2>Create tenant</h2>
    <form onSubmit={submit}>
      <label>Tenant name<input required value={form.name} onChange={(e) => update('name', e.target.value)} /></label>
      <label>Slug<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={form.slug} onChange={(e) => update('slug', e.target.value)} /></label>
      <label>Tenant type<select value={form.tenantType} onChange={(e) => update('tenantType', e.target.value)}>
        {TENANT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
      </select></label>
      <label>Initial admin email<input type="email" required value={form.adminEmail} onChange={(e) => update('adminEmail', e.target.value)} /></label>
      <label>Temporary password<input required minLength={8} value={form.adminPassword} onChange={(e) => update('adminPassword', e.target.value)} /></label>
      <button disabled={busy} type="submit">{busy ? 'Creating…' : 'Create tenant'}</button>
      {createError && <p className="error" role="alert">{createError.message}</p>}
      {created && <p role="status">Created tenant &quot;{created.tenant.name}&quot; with initial admin {created.adminEmail}.</p>}
    </form>
  </section>;
}
