import { NavLink } from 'react-router-dom';

const NAV_BY_ROLE = {
  operator: [['/compose', 'Compose'], ['/alerts', 'Alerts']],
  tenant_admin: [
    ['/compose', 'Compose'], ['/alerts', 'Alerts'],
    ['/recipients', 'Recipients'], ['/groups', 'Groups'], ['/users', 'Team'],
  ],
  platform_admin: [['/admin/tenants', 'Tenants']],
};

export function Header({ onLogout, role }) {
  const links = NAV_BY_ROLE[role] || NAV_BY_ROLE.operator;
  return <header className="app-header">
    <div><strong>Critical Notifications</strong><span className="eyebrow">demo console</span></div>
    <nav>{links.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}</nav>
    <button type="button" className="logout-button" onClick={onLogout}>Log out</button>
  </header>;
}
