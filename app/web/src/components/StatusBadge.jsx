export function StatusBadge({ status }) {
  return <span className={`status status-${status}`}>{status || 'unknown'}</span>;
}
