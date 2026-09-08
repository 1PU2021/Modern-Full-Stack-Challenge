export function ImpersonationBanner({ tenantName, onExit }) {
  return <div className="impersonation-banner" role="status">
    <strong>Acting as {tenantName} as Platform Administrator</strong>
    <button type="button" onClick={onExit}>Exit impersonation</button>
  </div>;
}
