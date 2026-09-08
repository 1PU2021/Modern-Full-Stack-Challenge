import { useEffect, useState } from 'react';
import { PolygonEditor } from '../components/PolygonEditor';
import { DEMO_POLYGON } from '../demo-geography';
import { useGroups } from '../hooks/useGroups';

export function buildAlertPayload(form) { return { title: form.title, body: form.body, priority: form.priority, channels: form.channels, target: form.targetType === 'group' ? { type: 'group', groupId: form.groupId } : { type: 'polygon', geojson: form.geojson } }; }
export function ComposeView({ api, tenantSlug }) {
  const { groups, loading: groupsLoading } = useGroups(api);
  const [recipientsState, setRecipientsState] = useState({ recipients: [], loading: true, error: null });
  const [form, setForm] = useState({
    title: '', body: '', priority: 'normal', channels: ['sms'], targetType: 'group', groupId: '', geojson: DEMO_POLYGON,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setRecipientsState({ recipients: [], loading: true, error: null });
    void api.listRecipients().then(
      (recipients) => {
        if (!cancelled) setRecipientsState({ recipients, loading: false, error: null });
      },
      (loadError) => {
        if (!cancelled) setRecipientsState({ recipients: [], loading: false, error: loadError });
      }
    );
    return () => { cancelled = true; };
  }, [api]);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.createAlert(buildAlertPayload(form)));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const toggleChannel = (channel) => update(
    'channels',
    form.channels.includes(channel)
      ? form.channels.filter((item) => item !== channel)
      : [...form.channels, channel]
  );

  return <section className="card">
    <h1>Compose alert</h1>
    <form onSubmit={submit}>
      <label>Title<input required value={form.title} onChange={(e) => update('title', e.target.value)} /></label>
      <label>Message<textarea required value={form.body} onChange={(e) => update('body', e.target.value)} /></label>
      <label>Priority<select value={form.priority} onChange={(e) => update('priority', e.target.value)}>{['low', 'normal', 'high', 'critical'].map((p) => <option key={p}>{p}</option>)}</select></label>
      <fieldset><legend>Channels</legend>{['sms', 'email'].map((channel) => <label key={channel}><input type="checkbox" checked={form.channels.includes(channel)} onChange={() => toggleChannel(channel)} />{channel}</label>)}</fieldset>
      <label>Target<select value={form.targetType} onChange={(e) => update('targetType', e.target.value)}><option value="group">Group</option><option value="polygon">Polygon</option></select></label>
      {form.targetType === 'group'
        ? <label>Group<select required value={form.groupId} onChange={(e) => update('groupId', e.target.value)}><option value="">{groupsLoading ? 'Loading…' : 'Select a group'}</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>)}</select></label>
        : <>
          {recipientsState.loading && <p role="status">Loading recipient locations…</p>}
          {recipientsState.error && <p className="error" role="alert">Recipient locations could not be loaded. The map will not show recipient dots.</p>}
          <PolygonEditor
            value={form.geojson}
            onChange={(geojson) => update('geojson', geojson)}
            tenantSlug={tenantSlug}
            recipients={recipientsState.recipients}
          />
        </>}
      <button disabled={busy || !form.channels.length} type="submit">{busy ? 'Submitting…' : 'Submit alert'}</button>
      {error && <p className="error">{error.message}</p>}
      {result && <p role="status">Accepted alert <code>{result.alertId}</code>{result.replayed ? ' (replayed)' : ''}</p>}
    </form>
  </section>;
}
