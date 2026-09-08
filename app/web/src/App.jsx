import { useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { createApi, createPlatformApi } from './api';
import { Header } from './components/Header';
import { ComposeView } from './views/ComposeView';
import { GroupsView } from './views/GroupsView';
import { AlertsView } from './views/AlertsView';
import { AlertDetailView } from './views/AlertDetailView';
import { LoginView } from './views/LoginView';
import { PlatformLoginView } from './views/PlatformLoginView';
import { RecipientsView } from './views/RecipientsView';
import { UsersView } from './views/UsersView';
import { TenantsView } from './views/TenantsView';
import { ImpersonationBanner } from './components/ImpersonationBanner';

function loadStoredSessions() {
  const stored = {
    token: sessionStorage.getItem('demo-token') || '',
    tenantSlug: sessionStorage.getItem('demo-tenant-slug') || '',
    role: sessionStorage.getItem('demo-role') || '',
    platformToken: sessionStorage.getItem('demo-platform-token') || '',
    impersonation: null,
  };
  const raw = sessionStorage.getItem('demo-impersonation');
  if (!raw) return stored;
  try {
    stored.impersonation = JSON.parse(raw);
  } catch {
    sessionStorage.removeItem('demo-impersonation');
    return stored;
  }
  if (!stored.token || !stored.platformToken) {
    sessionStorage.removeItem('demo-token');
    sessionStorage.removeItem('demo-tenant-slug');
    sessionStorage.removeItem('demo-role');
    sessionStorage.removeItem('demo-impersonation');
    stored.token = '';
    stored.tenantSlug = '';
    stored.role = '';
    stored.impersonation = null;
  }
  return stored;
}

export function App() {
  const [stored] = useState(loadStoredSessions);
  const [token, setTokenState] = useState(stored.token);
  const [tenantSlug, setTenantSlugState] = useState(stored.tenantSlug);
  const [role, setRoleState] = useState(stored.role);
  const [platformToken, setPlatformTokenState] = useState(stored.platformToken);
  const [impersonation, setImpersonation] = useState(stored.impersonation);
  const [showPlatformLogin, setShowPlatformLogin] = useState(false);

  const setSession = (nextToken, nextTenantSlug, nextRole) => {
    setTokenState(nextToken);
    setTenantSlugState(nextTenantSlug);
    setRoleState(nextRole);
    sessionStorage.setItem('demo-token', nextToken);
    sessionStorage.setItem('demo-tenant-slug', nextTenantSlug);
    sessionStorage.setItem('demo-role', nextRole);
  };
  const clearToken = () => {
    setTokenState('');
    setTenantSlugState('');
    setRoleState('');
    sessionStorage.removeItem('demo-token');
    sessionStorage.removeItem('demo-tenant-slug');
    sessionStorage.removeItem('demo-role');
  };

  // A platform session is entirely independent of a tenant session: its own
  // sessionStorage key, its own token, its own api client -- clearing one
  // never touches the other (see App.test.jsx for the case where both are
  // stored at once).
  const setPlatformSession = (nextToken) => {
    setPlatformTokenState(nextToken);
    sessionStorage.setItem('demo-platform-token', nextToken);
  };
  const clearPlatformToken = () => {
    setPlatformTokenState('');
    sessionStorage.removeItem('demo-platform-token');
  };

  const api = useMemo(() => createApi({ getToken: () => token, onUnauthorized: clearToken }), [token]);
  const platformApi = useMemo(() => createPlatformApi({ getToken: () => platformToken, onUnauthorized: clearPlatformToken }), [platformToken]);

  const startImpersonation = async (tenant) => {
    const result = await platformApi.impersonateTenant(tenant.id);
    const metadata = { tenantId: result.tenant.id, tenantName: result.tenant.name };
    setSession(result.token, result.tenant.slug, result.role);
    setImpersonation(metadata);
    sessionStorage.setItem('demo-impersonation', JSON.stringify(metadata));
  };
  const exitImpersonation = () => {
    clearToken();
    setImpersonation(null);
    sessionStorage.removeItem('demo-impersonation');
  };

  if (platformToken && !impersonation) {
    return <BrowserRouter><Header onLogout={clearPlatformToken} role="platform_admin" /><main className="page"><Routes>
      <Route path="/admin/tenants" element={<TenantsView api={platformApi} onImpersonate={startImpersonation} />} />
      <Route path="*" element={<Navigate to="/admin/tenants" replace />} />
    </Routes></main></BrowserRouter>;
  }

  if (!token) {
    if (showPlatformLogin) {
      return <PlatformLoginView api={platformApi} onLogin={setPlatformSession} onBack={() => setShowPlatformLogin(false)} />;
    }
    return <LoginView api={api} onLogin={setSession} onShowPlatformLogin={() => setShowPlatformLogin(true)} />;
  }

  return <BrowserRouter>
    {impersonation && <ImpersonationBanner tenantName={impersonation.tenantName} onExit={exitImpersonation} />}
    <Header onLogout={impersonation ? exitImpersonation : clearToken} role={role} /><main className="page"><Routes>
    <Route path="/compose" element={<ComposeView api={api} tenantSlug={tenantSlug} />} />
    <Route path="/alerts" element={<AlertsView api={api} />} />
    <Route path="/alerts/:id" element={<AlertDetailView api={api} />} />
    <Route path="/groups" element={<GroupsView api={api} role={role} />} />
    {role === 'tenant_admin' && <Route path="/recipients" element={<RecipientsView api={api} />} />}
    {role === 'tenant_admin' && <Route path="/users" element={<UsersView api={api} />} />}
    <Route path="*" element={<Navigate to="/compose" replace />} />
  </Routes><div hidden>{api ? 'api-ready' : ''}</div></main></BrowserRouter>;
}
