import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupsView } from './GroupsView';

function makeApi(overrides = {}) {
  return {
    listGroups: vi.fn().mockResolvedValue([{ id: 'g1', name: 'Emergency', memberCount: 1 }]),
    createGroup: vi.fn().mockResolvedValue({ id: 'g2', name: 'New Group', memberCount: 0 }),
    renameGroup: vi.fn().mockResolvedValue({ id: 'g1', name: 'Emergency Renamed' }),
    deleteGroup: vi.fn().mockResolvedValue(undefined),
    getGroupMembers: vi.fn().mockResolvedValue({
      group: { id: 'g1', name: 'Emergency' },
      members: [{ id: 'r1', name: 'Jamie Rivera', email: 'jamie@example.test', phone: null, active: true }],
    }),
    listRecipients: vi.fn().mockResolvedValue([
      { id: 'r1', name: 'Jamie Rivera', active: true },
      { id: 'r2', name: 'Alex Kim', active: true },
    ]),
    addGroupMember: vi.fn().mockResolvedValue({ groupId: 'g1', recipientId: 'r2' }),
    removeGroupMember: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('GroupsView', () => {
  afterEach(cleanup);

  it('renders groups and counts', async () => {
    render(<GroupsView api={{ listGroups: vi.fn().mockResolvedValue([{ id: 'g', name: 'Emergency', memberCount: 4 }]) }} />);
    expect(await screen.findByText('Emergency')).toBeInTheDocument();
    expect(screen.getByText('4 members')).toBeInTheDocument();
  });

  it('hides admin controls for a non-admin role', async () => {
    render(<GroupsView api={makeApi()} role="operator" />);
    await screen.findByText('Emergency');
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create group/i })).not.toBeInTheDocument();
  });

  it('creates a group as tenant_admin', async () => {
    const api = makeApi();
    render(<GroupsView api={api} role="tenant_admin" />);
    await screen.findByText('Emergency');

    fireEvent.change(screen.getByLabelText(/group name/i), { target: { value: 'New Group' } });
    fireEvent.click(screen.getByRole('button', { name: /create group/i }));

    await waitFor(() => expect(api.createGroup).toHaveBeenCalledWith({ name: 'New Group' }));
    expect(api.listGroups).toHaveBeenCalledTimes(2);
  });

  it('renames a group', async () => {
    const api = makeApi();
    render(<GroupsView api={api} role="tenant_admin" />);
    const row = (await screen.findByText('Emergency')).closest('.list-row');

    fireEvent.click(within(row).getByRole('button', { name: /rename/i }));
    const input = within(row).getByDisplayValue('Emergency');
    fireEvent.change(input, { target: { value: 'Emergency Renamed' } });
    fireEvent.click(within(row).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.renameGroup).toHaveBeenCalledWith('g1', { name: 'Emergency Renamed' }));
  });

  it('deletes a group', async () => {
    const api = makeApi();
    render(<GroupsView api={api} role="tenant_admin" />);
    const row = (await screen.findByText('Emergency')).closest('.list-row');

    fireEvent.click(within(row).getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(api.deleteGroup).toHaveBeenCalledWith('g1'));
  });

  it('manages group membership: lists, adds, and removes recipients', async () => {
    const api = makeApi();
    render(<GroupsView api={api} role="tenant_admin" />);
    const row = (await screen.findByText('Emergency')).closest('.list-row');

    fireEvent.click(within(row).getByRole('button', { name: /manage members/i }));
    await waitFor(() => expect(api.getGroupMembers).toHaveBeenCalledWith('g1'));
    await screen.findByText('Jamie Rivera');

    fireEvent.change(screen.getByLabelText(/add recipient/i), { target: { value: 'r2' } });
    fireEvent.click(screen.getByRole('button', { name: /add to group/i }));
    await waitFor(() => expect(api.addGroupMember).toHaveBeenCalledWith('g1', 'r2'));

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(api.removeGroupMember).toHaveBeenCalledWith('g1', 'r1'));
  });
});
