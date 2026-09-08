import { useCallback, useEffect, useState } from 'react';
import { useGroups } from '../hooks/useGroups';

function MemberManager({ api, group, onClose, onChanged }) {
  const [members, setMembers] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedRecipientId, setSelectedRecipientId] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [membersResult, recipientsResult] = await Promise.all([
        api.getGroupMembers(group.id),
        api.listRecipients(),
      ]);
      setMembers(membersResult.members);
      setRecipients(recipientsResult);
    } catch (fetchError) {
      setError(fetchError);
    } finally {
      setLoading(false);
    }
  }, [api, group.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const memberIds = new Set(members.map((member) => member.id));
  const available = recipients.filter((recipient) => recipient.active && !memberIds.has(recipient.id));

  const addMember = async () => {
    if (!selectedRecipientId) return;
    setBusy(true);
    try {
      await api.addGroupMember(group.id, selectedRecipientId);
      setSelectedRecipientId('');
      await refresh();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (recipientId) => {
    await api.removeGroupMember(group.id, recipientId);
    await refresh();
    onChanged();
  };

  return <div className="group-members">
    <h3>Members of {group.name}</h3>
    {loading && <p>Loading members…</p>}
    {error && <p className="error">Unable to load members: {error.message}</p>}
    {!loading && !error && <>
      <ul>{members.map((member) => <li key={member.id}>
        {member.name}
        <button type="button" onClick={() => removeMember(member.id)}>Remove</button>
      </li>)}</ul>
      <label>Add recipient
        <select value={selectedRecipientId} onChange={(e) => setSelectedRecipientId(e.target.value)}>
          <option value="">Select a recipient…</option>
          {available.map((recipient) => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}
        </select>
      </label>
      <button disabled={busy || !selectedRecipientId} type="button" onClick={addMember}>Add to group</button>
    </>}
    <button type="button" onClick={onClose}>Close</button>
  </div>;
}

export function GroupsView({ api, role }) {
  const { groups, loading, error, refresh } = useGroups(api);
  const isAdmin = role === 'tenant_admin';

  const [newName, setNewName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [manageId, setManageId] = useState(null);

  const createGroup = async (event) => {
    event.preventDefault();
    setCreateBusy(true);
    setCreateError(null);
    try {
      await api.createGroup({ name: newName });
      setNewName('');
      await refresh();
    } catch (submitError) {
      setCreateError(submitError);
    } finally {
      setCreateBusy(false);
    }
  };

  const startRename = (group) => {
    setRenamingId(group.id);
    setRenameValue(group.name);
  };

  const saveRename = async (groupId) => {
    await api.renameGroup(groupId, { name: renameValue });
    setRenamingId(null);
    await refresh();
  };

  const removeGroup = async (groupId) => {
    await api.deleteGroup(groupId);
    if (manageId === groupId) setManageId(null);
    await refresh();
  };

  return <section className="card">
    <h1>Groups</h1>
    {loading && <p>Loading groups…</p>}
    {error && <p className="error">Unable to load groups: {error.message}</p>}
    {!loading && !error && !groups.length && <p>No groups found.</p>}
    {groups.map((group) => <div className="list-row" key={group.id}>
      {renamingId === group.id
        ? <label>Rename {group.name}
            <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          </label>
        : <strong>{group.name}</strong>}
      <span>{group.memberCount} members</span>
      {isAdmin && renamingId === group.id && <div className="inline-controls">
        <button type="button" onClick={() => saveRename(group.id)}>Save</button>
        <button type="button" onClick={() => setRenamingId(null)}>Cancel</button>
      </div>}
      {isAdmin && renamingId !== group.id && <div className="inline-controls">
        <button type="button" onClick={() => setManageId(manageId === group.id ? null : group.id)}>
          {manageId === group.id ? 'Hide members' : 'Manage members'}
        </button>
        <button type="button" onClick={() => startRename(group)}>Rename</button>
        <button type="button" onClick={() => removeGroup(group.id)}>Delete</button>
      </div>}
      {isAdmin && manageId === group.id && (
        <MemberManager api={api} group={group} onClose={() => setManageId(null)} onChanged={refresh} />
      )}
    </div>)}

    {isAdmin && <>
      <h2>Create group</h2>
      <form onSubmit={createGroup}>
        <label>Group name<input required value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
        <button disabled={createBusy} type="submit">{createBusy ? 'Creating…' : 'Create group'}</button>
        {createError && <p className="error" role="alert">{createError.message}</p>}
      </form>
    </>}
  </section>;
}
