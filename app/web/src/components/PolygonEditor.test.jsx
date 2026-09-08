import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_MAP_VIEW_BY_TENANT, DEMO_POLYGON } from '../demo-geography';
import { PolygonEditor } from './PolygonEditor';

const mocks = vi.hoisted(() => ({
  clear: vi.fn(), events: {}, getMode: vi.fn(() => 'polygon'), getSnapshotFeature: vi.fn(), setMode: vi.fn(), start: vi.fn(), stop: vi.fn(), remove: vi.fn(),
  fitBounds: vi.fn(), mapOptions: null, addSource: vi.fn(), addLayer: vi.fn(), setData: vi.fn(), source: null,
}));
vi.mock('maplibre-gl', () => ({
  Map: class {
    constructor(options) { mocks.mapOptions = options; }
    on(event, callback) { if (event === 'load') callback(); }
    remove() { mocks.remove(); }
    fitBounds(bounds, options) { mocks.fitBounds(bounds, options); }
    addSource(id, options) { mocks.addSource(id, options); mocks.source = { setData: mocks.setData }; }
    getSource() { return mocks.source; }
    addLayer(options) { mocks.addLayer(options); }
  },
  LngLatBounds: class {
    constructor() { this.points = []; }
    extend(lngLat) { this.points.push(lngLat); return this; }
  },
}));
vi.mock('terra-draw', () => ({
  TerraDraw: class { clear() { mocks.clear(); } getMode() { return mocks.getMode(); } getSnapshotFeature(id) { return mocks.getSnapshotFeature(id); } start() { mocks.start(); } setMode(mode) { mocks.setMode(mode); } on(event, callback) { mocks.events[event] = callback; } stop() { mocks.stop(); } },
  TerraDrawPolygonMode: class {},
}));
vi.mock('terra-draw-maplibre-gl-adapter', () => ({ TerraDrawMapLibreGLAdapter: class {} }));

const LIVE_RECIPIENTS = [
  {
    id: 'recipient-live', name: 'Manually added recipient', phone: '+15551230000', email: 'live@example.test',
    addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
    longitude: -86.701, latitude: 39.711, active: true, createdAt: '2026-08-31T12:00:00.000Z',
  },
  {
    id: 'recipient-no-location', name: 'No location', phone: null, email: 'no-location@example.test',
    addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
    longitude: null, latitude: null, active: true, createdAt: '2026-08-31T12:00:00.000Z',
  },
  {
    id: 'recipient-inactive', name: 'Inactive recipient', phone: null, email: 'inactive@example.test',
    addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
    longitude: -86.69, latitude: 39.72, active: false, createdAt: '2026-08-31T12:00:00.000Z',
  },
];

function sourceFeatureCoords() {
  const call = mocks.addSource.mock.calls.at(-1);
  return call[1].data.features.map((feature) => feature.geometry.coordinates);
}

describe('PolygonEditor', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.getSnapshotFeature.mockReset();
    mocks.events = {};
    mocks.mapOptions = null;
    mocks.source = null;
  });

  it('renders only live API recipients with valid coordinates', async () => {
    render(<PolygonEditor onChange={() => {}} tenantSlug="demo-county" recipients={LIVE_RECIPIENTS} />);
    await waitFor(() => expect(mocks.addSource).toHaveBeenCalledTimes(1));
    expect(sourceFeatureCoords()).toEqual([[-86.701, 39.711]]);
    const layerIds = mocks.addLayer.mock.calls.map(([layer]) => layer.id);
    expect(layerIds).toEqual(['tenant-recipients-clusters', 'tenant-recipients-cluster-count', 'tenant-recipients-point']);
  });

  it('updates live recipient dots without recreating the active drawing map', async () => {
    const { rerender } = render(<PolygonEditor onChange={() => {}} tenantSlug="demo-county" recipients={LIVE_RECIPIENTS} />);
    await waitFor(() => expect(mocks.addSource).toHaveBeenCalledTimes(1));
    rerender(<PolygonEditor onChange={() => {}} tenantSlug="demo-county" recipients={[]} />);
    await waitFor(() => expect(mocks.setData).toHaveBeenCalledWith({ type: 'FeatureCollection', features: [] }));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.addSource).toHaveBeenCalledTimes(1);
  });

  it('fits the map to live recipients once on load and again on request', async () => {
    render(<PolygonEditor onChange={() => {}} tenantSlug="demo-school" recipients={LIVE_RECIPIENTS} />);
    await waitFor(() => expect(mocks.fitBounds).toHaveBeenCalledTimes(1));
    const [bounds, options] = mocks.fitBounds.mock.calls[0];
    expect(bounds.points).toEqual([[-86.701, 39.711]]);
    expect(options).toMatchObject({ maxZoom: expect.any(Number), padding: expect.any(Number) });

    fireEvent.click(screen.getByRole('button', { name: /fit recipients/i }));
    expect(mocks.fitBounds).toHaveBeenCalledTimes(2);
  });

  it('initializes the map centered on the authenticated tenant\'s own region', async () => {
    render(<PolygonEditor onChange={() => {}} tenantSlug="demo-school" />);
    await waitFor(() => expect(mocks.mapOptions).not.toBeNull());
    expect(mocks.mapOptions).toMatchObject(DEMO_MAP_VIEW_BY_TENANT['demo-school']);
  });

  it('renders no recipient source when live data is empty instead of using a static fallback', async () => {
    render(<PolygonEditor onChange={() => {}} tenantSlug="demo-county" recipients={[]} />);
    await waitFor(() => expect(mocks.getMode).toHaveBeenCalled());
    expect(mocks.addSource).not.toHaveBeenCalled();
    expect(mocks.addLayer).not.toHaveBeenCalled();
    expect(mocks.fitBounds).not.toHaveBeenCalled();
  });

  it('explicitly enables polygon drawing and explains how to finish it', async () => {
    render(<PolygonEditor onChange={() => {}} tenantSlug="demo-county" />);
    expect(screen.getByText(/click the map to add vertices/i)).toBeInTheDocument();
    await waitFor(() => expect(mocks.setMode).toHaveBeenCalledWith('polygon'));
    expect(mocks.start.mock.invocationCallOrder[0]).toBeLessThan(mocks.setMode.mock.invocationCallOrder[0]);
    expect(mocks.getMode).toHaveBeenCalled();
  });

  it('publishes the completed Terra Draw polygon geometry', async () => {
    const onChange = vi.fn();
    const geometry = { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [1, 2], [1, 1]]] };
    mocks.getSnapshotFeature.mockReturnValue({ id: 'drawn', type: 'Feature', properties: {}, geometry });
    render(<PolygonEditor onChange={onChange} tenantSlug="demo-county" />);
    await waitFor(() => expect(mocks.events.finish).toBeTypeOf('function'));
    mocks.events.finish('drawn');
    expect(onChange).toHaveBeenCalledWith(geometry);
  });

  it('offers the deterministic seeded-data polygon', () => {
    const onChange = vi.fn();
    render(<PolygonEditor onChange={onChange} tenantSlug="demo-county" />);
    fireEvent.click(screen.getByText(/demo polygon/i));
    expect(onChange).toHaveBeenCalledWith(DEMO_POLYGON);
  });

  it('clears the active drawing and leaves polygon mode ready for another polygon', async () => {
    const onChange = vi.fn();
    render(<PolygonEditor value={DEMO_POLYGON} onChange={onChange} tenantSlug="demo-county" />);
    await waitFor(() => expect(mocks.setMode).toHaveBeenCalledWith('polygon'));
    fireEvent.click(screen.getByRole('button', { name: /clear polygon/i }));
    expect(mocks.clear).toHaveBeenCalled();
    expect(mocks.setMode).toHaveBeenLastCalledWith('polygon');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('tears down the map (and its recipient source/layers with it) on unmount', async () => {
    const { unmount } = render(<PolygonEditor onChange={() => {}} tenantSlug="demo-county" recipients={LIVE_RECIPIENTS} />);
    await waitFor(() => expect(mocks.addSource).toHaveBeenCalledTimes(1));
    unmount();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});
