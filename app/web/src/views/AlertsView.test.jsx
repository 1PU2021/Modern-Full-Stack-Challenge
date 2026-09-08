import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AlertsView } from './AlertsView';
describe('AlertsView', () => { it('renders loading and then an alert', async () => { render(<MemoryRouter><AlertsView api={{ listAlerts: vi.fn().mockResolvedValue([{ id: 'a', title: 'Storm', status: 'accepted', priority: 'high', channels: ['sms'] }]) }} /></MemoryRouter>); expect(await screen.findByText('Storm')).toBeInTheDocument(); }); });
