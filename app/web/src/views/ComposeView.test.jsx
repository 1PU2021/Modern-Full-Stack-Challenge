import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { buildAlertPayload, ComposeView } from './ComposeView';
import { DEMO_POLYGON } from '../demo-geography';

vi.mock('../components/PolygonEditor', () => ({
  PolygonEditor: ({ recipients = [] }) => <output aria-label="Map recipient coordinates">
    {JSON.stringify(recipients.map(({ longitude, latitude }) => [longitude, latitude]))}
  </output>,
}));
it('serializes group and polygon targets', () => { expect(buildAlertPayload({ title: 'x', body: 'y', priority: 'high', channels: ['email'], targetType: 'group', groupId: 'g' }).target).toEqual({ type: 'group', groupId: 'g' }); expect(buildAlertPayload({ title: 'x', body: 'y', priority: 'normal', channels: ['sms'], targetType: 'polygon', geojson: { type: 'Polygon' } }).target).toEqual({ type: 'polygon', geojson: { type: 'Polygon' } }); });

it('uses the shared deterministic demo polygon contract', () => {
  expect(buildAlertPayload({ title: 'x', body: 'y', priority: 'normal', channels: ['sms'], targetType: 'polygon', geojson: DEMO_POLYGON }).target.geojson).toEqual(DEMO_POLYGON);
});

it('loads active tenant recipients and supplies the live coordinates to the polygon map', async () => {
  const recipient = {
    id: 'recipient-live', name: 'Manually added recipient', phone: '+15551230000', email: 'live@example.test',
    addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
    longitude: -86.701, latitude: 39.711, active: true, createdAt: '2026-08-31T12:00:00.000Z',
  };
  const api = {
    listGroups: vi.fn().mockResolvedValue([]),
    listRecipients: vi.fn().mockResolvedValue([recipient]),
    createAlert: vi.fn(),
  };

  render(<ComposeView api={api} tenantSlug="demo-county" />);
  await waitFor(() => expect(api.listRecipients).toHaveBeenCalledWith());
  fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'polygon' } });
  expect(await screen.findByLabelText('Map recipient coordinates')).toHaveTextContent('[[-86.701,39.711]]');
});
