import { useCallback, useEffect, useState } from 'react';
import { parseCsv } from '../csv';

const EMPTY_ADD_FORM = {
  name: '', phone: '', email: '',
  addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', country: '',
  longitude: '', latitude: '',
};
const CSV_PREVIEW_ROWS = 5;

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function formFromRecipient(recipient) {
  return {
    name: recipient.name, phone: recipient.phone || '', email: recipient.email || '',
    addressLine1: recipient.addressLine1 || '', addressLine2: recipient.addressLine2 || '',
    city: recipient.city || '', state: recipient.state || '', postalCode: recipient.postalCode || '',
    country: recipient.country || '',
    longitude: recipient.longitude ?? '', latitude: recipient.latitude ?? '',
  };
}

// Address is the primary, user-facing way to give a recipient a location --
// the server geocodes it into the coordinates polygon targeting actually
// uses. Longitude/latitude stay available as an advanced/manual override
// (tucked under a <details> below) for when geocoding isn't configured or
// can't resolve an address, but a normal tenant admin should never need to
// type coordinates.
function addressPayload(form) {
  const hasAddress = Boolean(form.addressLine1 || form.city || form.state || form.postalCode);
  if (!hasAddress) return {};
  return {
    addressLine1: form.addressLine1,
    addressLine2: form.addressLine2 || null,
    city: form.city,
    state: form.state,
    postalCode: form.postalCode,
    country: form.country || null,
  };
}

// Explicit nulls, not an omitted key: the backend distinguishes "address
// untouched" (keys absent from the PATCH body) from "address intentionally
// cleared" (keys present, all null) purely by key presence -- sending `{}`
// for a cleared address would look identical to never having touched it,
// and the old address/location would silently survive the edit.
const EMPTY_ADDRESS_PAYLOAD = {
  addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
};

function coordsPayload(form) {
  if (form.longitude === '' || form.latitude === '') return {};
  return { longitude: Number(form.longitude), latitude: Number(form.latitude) };
}

function toCreatePayload(form) {
  return { name: form.name, phone: form.phone || null, email: form.email || null, ...addressPayload(form), ...coordsPayload(form) };
}

// An edit always re-sends the full form, but the address/coordinates are
// only included if they actually changed from what's already on the
// recipient -- otherwise every routine name-only edit would silently
// re-trigger a geocode call for an address that didn't change.
function addressUnchanged(form, recipient) {
  return form.addressLine1 === (recipient.addressLine1 || '')
    && form.addressLine2 === (recipient.addressLine2 || '')
    && form.city === (recipient.city || '')
    && form.state === (recipient.state || '')
    && form.postalCode === (recipient.postalCode || '')
    && form.country === (recipient.country || '');
}

function coordsUnchanged(form, recipient) {
  const recipientLongitude = recipient.longitude === null || recipient.longitude === undefined ? '' : String(recipient.longitude);
  const recipientLatitude = recipient.latitude === null || recipient.latitude === undefined ? '' : String(recipient.latitude);
  return form.longitude === recipientLongitude && form.latitude === recipientLatitude;
}

function toUpdatePayload(form, recipient) {
  const payload = { name: form.name, phone: form.phone || null, email: form.email || null };
  if (!addressUnchanged(form, recipient)) {
    const hasAddress = Boolean(form.addressLine1 || form.city || form.state || form.postalCode);
    Object.assign(payload, hasAddress ? addressPayload(form) : EMPTY_ADDRESS_PAYLOAD);
  }
  if (!coordsUnchanged(form, recipient)) Object.assign(payload, coordsPayload(form));
  return payload;
}

function locationConfirmationFor(recipient) {
  if (!recipient.city || recipient.longitude === null || recipient.longitude === undefined) return null;
  return { city: recipient.city, state: recipient.state, postalCode: recipient.postalCode };
}

function LocationConfirmation({ confirmation }) {
  if (!confirmation) return null;
  return <p className="location-confirmation" role="status">
    Location verified<br />
    {confirmation.city}, {confirmation.state} {confirmation.postalCode}
  </p>;
}

function AdvancedLocationFields({ form, onChange }) {
  return <details className="advanced-location">
    <summary>Advanced: manual coordinates</summary>
    <p>Only needed if geocoding is unavailable or an address can&apos;t be resolved.</p>
    <label>Longitude<input value={form.longitude} onChange={(e) => onChange('longitude', e.target.value)} /></label>
    <label>Latitude<input value={form.latitude} onChange={(e) => onChange('latitude', e.target.value)} /></label>
  </details>;
}

function AddressFields({ form, onChange }) {
  return <>
    <label>Address line 1<input value={form.addressLine1} onChange={(e) => onChange('addressLine1', e.target.value)} /></label>
    <label>Address line 2<input value={form.addressLine2} onChange={(e) => onChange('addressLine2', e.target.value)} /></label>
    <label>City<input value={form.city} onChange={(e) => onChange('city', e.target.value)} /></label>
    <label>State<input value={form.state} onChange={(e) => onChange('state', e.target.value)} /></label>
    <label>Postal code<input value={form.postalCode} onChange={(e) => onChange('postalCode', e.target.value)} /></label>
    <label>Country<input placeholder="US" value={form.country} onChange={(e) => onChange('country', e.target.value)} /></label>
  </>;
}

function RecipientRow({ recipient, onSave, onDeactivate }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => formFromRecipient(recipient));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmation, setConfirmation] = useState(() => locationConfirmationFor(recipient));

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await onSave(recipient.id, toUpdatePayload(form, recipient));
      setConfirmation(locationConfirmationFor(saved));
      setEditing(false);
    } catch (saveError) {
      setError(saveError);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setForm(formFromRecipient(recipient));
    setError(null);
    setEditing(false);
  };

  if (editing) {
    return <tr>
      <td colSpan={4}>
        <label>Name<input value={form.name} onChange={(e) => update('name', e.target.value)} /></label>
        <label>Phone<input value={form.phone} onChange={(e) => update('phone', e.target.value)} /></label>
        <label>Email<input value={form.email} onChange={(e) => update('email', e.target.value)} /></label>
        <AddressFields form={form} onChange={update} />
        <AdvancedLocationFields form={form} onChange={update} />
      </td>
      <td>{recipient.active ? 'active' : 'inactive'}</td>
      <td className="inline-controls">
        <button type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={cancel}>Cancel</button>
        {error && <p className="error" role="alert">{error.details?.length ? error.details.map((d) => d.message).join('; ') : error.message}</p>}
      </td>
    </tr>;
  }

  return <tr>
    <td>{recipient.name}</td>
    <td>{recipient.phone || '—'}</td>
    <td>{recipient.email || '—'}</td>
    <td>{recipient.city ? `${recipient.city}, ${recipient.state || ''}`.trim() : '—'}</td>
    <td>{recipient.active ? 'active' : 'inactive'}</td>
    <td className="inline-controls">
      <button type="button" onClick={() => setEditing(true)}>Edit</button>
      {recipient.active && <button type="button" onClick={() => onDeactivate(recipient.id)}>Deactivate</button>}
      <LocationConfirmation confirmation={confirmation} />
    </td>
  </tr>;
}

export function RecipientsView({ api }) {
  const [recipients, setRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState(null);
  const [addConfirmation, setAddConfirmation] = useState(null);

  const [csvText, setCsvText] = useState('');
  const [csvPreview, setCsvPreview] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importResult, setImportResult] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      setRecipients(await api.listRecipients());
    } catch (error) {
      setListError(error);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateAddForm = (key, value) => setAddForm((current) => ({ ...current, [key]: value }));

  const submitAdd = async (event) => {
    event.preventDefault();
    setAddBusy(true);
    setAddError(null);
    try {
      const created = await api.createRecipient(toCreatePayload(addForm));
      setAddConfirmation(locationConfirmationFor(created));
      setAddForm(EMPTY_ADD_FORM);
      await refresh();
    } catch (error) {
      setAddError(error);
    } finally {
      setAddBusy(false);
    }
  };

  const saveRecipient = async (id, payload) => {
    const saved = await api.updateRecipient(id, payload);
    await refresh();
    return saved;
  };

  const deactivate = async (id) => {
    await api.deactivateRecipient(id);
    await refresh();
  };

  // The client-side parse below is preview-only: it lets the operator sanity
  // check what they selected before sending anything. The server re-parses
  // and re-validates the raw text independently and is the sole authority
  // on what actually gets imported (see recipients.js).
  const onCsvFileChange = async (event) => {
    const file = event.target.files?.[0];
    setImportResult(null);
    setImportError(null);
    if (!file) {
      setCsvText('');
      setCsvPreview(null);
      return;
    }
    const text = await readFileAsText(file);
    setCsvText(text);
    const rows = parseCsv(text);
    setCsvPreview(rows.length > 0 ? { header: rows[0], dataRows: rows.slice(1) } : null);
  };

  const confirmImport = async () => {
    setImportBusy(true);
    setImportError(null);
    try {
      const result = await api.importRecipients(csvText);
      setImportResult(result);
      setCsvText('');
      setCsvPreview(null);
      await refresh();
    } catch (error) {
      setImportError(error);
    } finally {
      setImportBusy(false);
    }
  };

  return <section className="card">
    <h1>Recipients</h1>
    {loading && <p>Loading recipients…</p>}
    {listError && <p className="error">Unable to load recipients: {listError.message}</p>}
    {!loading && !listError && <table>
      <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Location</th><th>Status</th><th /></tr></thead>
      <tbody>{recipients.map((recipient) => (
        <RecipientRow key={recipient.id} recipient={recipient} onSave={saveRecipient} onDeactivate={deactivate} />
      ))}</tbody>
    </table>}

    <h2>Add recipient</h2>
    <form onSubmit={submitAdd}>
      <label>Name<input required value={addForm.name} onChange={(e) => updateAddForm('name', e.target.value)} /></label>
      <label>Phone<input value={addForm.phone} onChange={(e) => updateAddForm('phone', e.target.value)} /></label>
      <label>Email<input type="email" value={addForm.email} onChange={(e) => updateAddForm('email', e.target.value)} /></label>
      <AddressFields form={addForm} onChange={updateAddForm} />
      <AdvancedLocationFields form={addForm} onChange={updateAddForm} />
      <button disabled={addBusy} type="submit">{addBusy ? 'Adding…' : 'Add recipient'}</button>
      {addError && <p className="error" role="alert">{addError.details?.length ? addError.details.map((d) => d.message).join('; ') : addError.message}</p>}
      <LocationConfirmation confirmation={addConfirmation} />
    </form>

    <h2>Import recipients from CSV</h2>
    <p>
      Columns: name (required), email, phone, address_line1, address_line2, city, state, postal_code, country, group.
      Rows naming an unknown group are rejected rather than creating one. latitude/longitude columns are also
      accepted as an advanced/manual override in place of an address.
    </p>
    <label>CSV file<input type="file" accept=".csv,text/csv" onChange={onCsvFileChange} /></label>
    {csvPreview && <div className="csv-preview">
      <table>
        <thead><tr>{csvPreview.header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{csvPreview.dataRows.slice(0, CSV_PREVIEW_ROWS).map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
        ))}</tbody>
      </table>
      {csvPreview.dataRows.length > CSV_PREVIEW_ROWS && (
        <p>Showing first {CSV_PREVIEW_ROWS} of {csvPreview.dataRows.length} rows.</p>
      )}
      <button disabled={importBusy} type="button" onClick={confirmImport}>{importBusy ? 'Importing…' : 'Confirm import'}</button>
    </div>}
    {importError && <p className="error" role="alert">{importError.details?.length ? importError.details.map((d) => d.message).join('; ') : importError.message}</p>}
    {importResult && <div role="status">
      <p>Imported {importResult.imported}, skipped {importResult.skipped}, failed {importResult.failed}.</p>
      {importResult.errors?.length > 0 && <ul>{importResult.errors.map((rowError) => (
        <li key={rowError.row}>Row {rowError.row}: {rowError.message}</li>
      ))}</ul>}
    </div>}
  </section>;
}
