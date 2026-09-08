import { Link } from 'react-router-dom';
import { StatusBadge } from '../components/StatusBadge';
import { useAlerts } from '../hooks/useAlerts';
export function AlertsView({ api }) { const { alerts, loading, error } = useAlerts(api); return <section className="card"><h1>Alerts</h1>{loading && <p>Loading alerts…</p>}{error && <p className="error">Unable to load alerts: {error.message}</p>}{!loading && !error && !alerts.length && <p>No alerts yet.</p>}<div>{alerts.map((alert) => <Link className="list-row" key={alert.id} to={`/alerts/${alert.id}`}><span><strong>{alert.title}</strong><small>{alert.priority} · {alert.channels.join(', ')}</small></span><StatusBadge status={alert.status} /></Link>)}</div></section>; }
