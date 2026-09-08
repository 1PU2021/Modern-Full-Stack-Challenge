import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecipientsView } from './RecipientsView';

function makeApi(overrides = {}) {
  return {
    listRecipients: vi.fn().mockResolvedValue([
      {
        id: 'r1', name: 'Jamie Rivera', phone: '+15551234567', email: 'jamie@example.test',
        addressLine1: '123 Main St', addressLine2: null, city: 'Rochester', state: 'IN', postalCode: '46975', country: 'US',
        longitude: -86.7, latitude: 39.7, active: true, createdAt: '2026-01-01T00:00:00Z',
      },
    ]),
    createRecipient: vi.fn().mockResolvedValue({ id: 'r2', name: 'New Person', phone: null, email: null, addressLine1: null, city: null, state: null, postalCode: null, longitude: null, latitude: null, active: true }),
    updateRecipient: vi.fn().mockResolvedValue({ id: 'r1', name: 'Jamie R.', phone: '+15551234567', email: 'jamie@example.test', addressLine1: '123 Main St', city: 'Rochester', state: 'IN', postalCode: '46975', longitude: -86.7, latitude: 39.7, active: true }),
    deactivateRecipient: vi.fn().mockResolvedValue({ id: 'r1', active: false }),
    importRecipients: vi.fn(),
    exportRecipients: vi.fn(),
    ...overrides,
  };
}

describe('RecipientsView', () => {
  afterEach(cleanup);

  it('lists existing recipients', async () => {
    const api = makeApi();
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());
    expect(api.listRecipients).toHaveBeenCalledOnce();
  });

  it('creates a recipient with just a name (contact fields optional)', async () => {
    const api = makeApi();
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'New Person' } });
    fireEvent.click(screen.getByRole('button', { name: /add recipient/i }));

    await waitFor(() => expect(api.createRecipient).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Person' })));
    expect(api.listRecipients).toHaveBeenCalledTimes(2);
  });

  it('edits a recipient inline', async () => {
    const api = makeApi();
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    const row = screen.getByText('Jamie Rivera').closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: /edit/i }));
    const nameInput = within(row).getByDisplayValue('Jamie Rivera');
    fireEvent.change(nameInput, { target: { value: 'Jamie R.' } });
    fireEvent.click(within(row).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.updateRecipient).toHaveBeenCalledWith('r1', expect.objectContaining({ name: 'Jamie R.' })));
  });

  it('deactivates a recipient', async () => {
    const api = makeApi();
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    const row = screen.getByText('Jamie Rivera').closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(api.deactivateRecipient).toHaveBeenCalledWith('r1'));
  });

  it('shows a validation-style error from the backend without crashing', async () => {
    const api = makeApi({ createRecipient: vi.fn().mockRejectedValue(Object.assign(new Error('validation_failed'), { status: 400, details: [{ path: 'longitude', message: 'longitude and latitude must be provided together' }] })) });
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText(/longitude/i), { target: { value: '-86.7' } });
    fireEvent.click(screen.getByRole('button', { name: /add recipient/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/longitude and latitude must be provided together/i);
  });

  it('creates a recipient with a postal address instead of raw coordinates', async () => {
    const api = makeApi();
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByLabelText(/address line 1/i), { target: { value: '456 Oak Ave' } });
    fireEvent.change(screen.getByLabelText(/^city$/i), { target: { value: 'Fort Wayne' } });
    fireEvent.change(screen.getByLabelText(/^state$/i), { target: { value: 'IN' } });
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '46802' } });
    fireEvent.click(screen.getByRole('button', { name: /add recipient/i }));

    await waitFor(() => expect(api.createRecipient).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Person', addressLine1: '456 Oak Ave', city: 'Fort Wayne', state: 'IN', postalCode: '46802',
    })));
    const payload = api.createRecipient.mock.calls[0][0];
    expect(payload).not.toHaveProperty('longitude');
  });

  it('shows a location-verified confirmation after a successful geocoded save, without geocoder internals', async () => {
    const api = makeApi({
      createRecipient: vi.fn().mockResolvedValue({
        id: 'r3', name: 'New Person', addressLine1: '456 Oak Ave', city: 'Fort Wayne', state: 'IN', postalCode: '46802',
        longitude: -85.1394, latitude: 41.0793, active: true,
      }),
    });
    const { container } = render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByLabelText(/address line 1/i), { target: { value: '456 Oak Ave' } });
    fireEvent.change(screen.getByLabelText(/^city$/i), { target: { value: 'Fort Wayne' } });
    fireEvent.change(screen.getByLabelText(/^state$/i), { target: { value: 'IN' } });
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '46802' } });
    fireEvent.click(screen.getByRole('button', { name: /add recipient/i }));

    const form = within(container.querySelector('form'));
    expect(await form.findByText(/location verified/i)).toBeInTheDocument();
    expect(form.getByText(/fort wayne, in 46802/i)).toBeInTheDocument();
  });

  it('supports manual coordinates under Advanced location, without sending address fields', async () => {
    const api = makeApi();
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Manual Pin' } });
    fireEvent.change(screen.getByLabelText(/longitude/i), { target: { value: '-86.7' } });
    fireEvent.change(screen.getByLabelText(/latitude/i), { target: { value: '39.7' } });
    fireEvent.click(screen.getByRole('button', { name: /add recipient/i }));

    await waitFor(() => expect(api.createRecipient).toHaveBeenCalledWith(expect.objectContaining({ longitude: -86.7, latitude: 39.7 })));
    const payload = api.createRecipient.mock.calls[0][0];
    expect(payload).not.toHaveProperty('addressLine1');
  });

  it('editing only the name does not resend the recipient\'s unchanged address', async () => {
    const api = makeApi();
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    const row = screen.getByText('Jamie Rivera').closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: /edit/i }));
    fireEvent.change(within(row).getByDisplayValue('Jamie Rivera'), { target: { value: 'Jamie R.' } });
    fireEvent.click(within(row).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.updateRecipient).toHaveBeenCalled());
    const payload = api.updateRecipient.mock.calls[0][1];
    expect(payload.name).toBe('Jamie R.');
    expect(payload).not.toHaveProperty('addressLine1');
  });

  it('clearing a recipient\'s address sends explicit nulls for all address fields, not an omitted payload', async () => {
    const api = makeApi({
      updateRecipient: vi.fn().mockResolvedValue({
        id: 'r1', name: 'Jamie Rivera', phone: '+15551234567', email: 'jamie@example.test',
        addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
        longitude: null, latitude: null, active: true,
      }),
    });
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    const row = screen.getByText('Jamie Rivera').closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: /edit/i }));
    fireEvent.change(within(row).getByLabelText(/address line 1/i), { target: { value: '' } });
    fireEvent.change(within(row).getByLabelText(/^city$/i), { target: { value: '' } });
    fireEvent.change(within(row).getByLabelText(/^state$/i), { target: { value: '' } });
    fireEvent.change(within(row).getByLabelText(/postal code/i), { target: { value: '' } });
    fireEvent.click(within(row).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.updateRecipient).toHaveBeenCalled());
    const payload = api.updateRecipient.mock.calls[0][1];
    expect(payload).toMatchObject({
      addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
    });
  });

  it('editing the address resends it for re-geocoding', async () => {
    const api = makeApi();
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    const row = screen.getByText('Jamie Rivera').closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: /edit/i }));
    fireEvent.change(within(row).getByLabelText(/^city$/i), { target: { value: 'Fort Wayne' } });
    fireEvent.click(within(row).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.updateRecipient).toHaveBeenCalled());
    const payload = api.updateRecipient.mock.calls[0][1];
    expect(payload.city).toBe('Fort Wayne');
    expect(payload.addressLine1).toBe('123 Main St');
  });

  it('shows a clear error when the address cannot be geocoded, leaving the form open', async () => {
    const api = makeApi({
      createRecipient: vi.fn().mockRejectedValue(Object.assign(new Error('validation_failed'), {
        status: 400, details: [{ path: 'address', message: 'Could not verify this address. Check the address and try again.' }],
      })),
    });
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Nowhere' } });
    fireEvent.change(screen.getByLabelText(/address line 1/i), { target: { value: '1 Nowhere Rd' } });
    fireEvent.change(screen.getByLabelText(/^city$/i), { target: { value: 'Nowhereville' } });
    fireEvent.change(screen.getByLabelText(/^state$/i), { target: { value: 'ZZ' } });
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: '00000' } });
    fireEvent.click(screen.getByRole('button', { name: /add recipient/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not verify this address/i);
  });

  it('previews a selected CSV file and imports it on confirm', async () => {
    const csvText = 'name,email\nAlex Kim,alex@example.test\nSam Lee,sam@example.test\n';
    const api = makeApi({ importRecipients: vi.fn().mockResolvedValue({ imported: 2, skipped: 0, failed: 0, errors: [] }) });
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    const file = new File([csvText], 'recipients.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText(/csv file/i), { target: { files: [file] } });

    await screen.findByText('Alex Kim');
    expect(screen.getByText('Sam Lee')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /confirm import/i }));

    await waitFor(() => expect(api.importRecipients).toHaveBeenCalledWith(csvText));
    expect(await screen.findByText(/imported 2, skipped 0, failed 0/i)).toBeInTheDocument();
    expect(api.listRecipients).toHaveBeenCalledTimes(2);
  });

  it('shows per-row errors from a partially failed import', async () => {
    const csvText = 'name,email\n,bad-email\nGood Name,good@example.test\n';
    const api = makeApi({
      importRecipients: vi.fn().mockResolvedValue({
        imported: 1, skipped: 0, failed: 1,
        errors: [{ row: 2, message: 'name is required; email is invalid' }],
      }),
    });
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    const file = new File([csvText], 'recipients.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText(/csv file/i), { target: { files: [file] } });
    await screen.findByText('Good Name');
    fireEvent.click(screen.getByRole('button', { name: /confirm import/i }));

    await waitFor(() => expect(api.importRecipients).toHaveBeenCalledWith(csvText));
    expect(await screen.findByText(/imported 1, skipped 0, failed 1/i)).toBeInTheDocument();
    expect(screen.getByText(/row 2: name is required; email is invalid/i)).toBeInTheDocument();
  });

  it('shows an error if the import request itself fails', async () => {
    const csvText = 'name\nAlex Kim\n';
    const api = makeApi({ importRecipients: vi.fn().mockRejectedValue(Object.assign(new Error('validation_failed'), { status: 400, details: [{ path: 'csv', message: "CSV must include a 'name' column" }] })) });
    render(<RecipientsView api={api} />);
    await waitFor(() => expect(screen.getByText('Jamie Rivera')).toBeInTheDocument());

    const file = new File([csvText], 'recipients.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText(/csv file/i), { target: { files: [file] } });
    await screen.findByText('Alex Kim');
    fireEvent.click(screen.getByRole('button', { name: /confirm import/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/name' column/i);
  });
});
