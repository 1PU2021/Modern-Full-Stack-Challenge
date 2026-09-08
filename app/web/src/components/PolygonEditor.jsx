import { useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_MAP_VIEW_BY_TENANT, DEMO_POLYGON } from '../demo-geography';

const FALLBACK_MAP_VIEW = DEMO_MAP_VIEW_BY_TENANT['demo-county'];
const NO_RECIPIENTS = [];
const RECIPIENTS_SOURCE_ID = 'tenant-recipients';

// The authenticated tenant's live, geolocated recipients are drawn as
// MapLibre-native GL circle/symbol layers rather than one DOM Marker per
// recipient. Two
// reasons: (1) clustering — rendering every point individually can collapse
// a tight cluster into an unreadable blob; a cluster bubble showing the count
// is a more honest representation
// than indistinguishable overlapping dots. (2) GL layers are painted by the
// map's own renderer using its real projection, so — unlike a DOM element —
// there is no CSS/position class of bug to reintroduce, and with no click
// handlers attached they never intercept pointer events from Terra Draw.
function recipientFeatureCollection(recipients) {
  return {
    type: 'FeatureCollection',
    features: recipients.map((recipient) => ({
      type: 'Feature',
      properties: { name: recipient.name },
      geometry: { type: 'Point', coordinates: [recipient.longitude, recipient.latitude] },
    })),
  };
}

function syncRecipientClusterLayer(map, recipients) {
  const data = recipientFeatureCollection(recipients);
  const source = map.getSource(RECIPIENTS_SOURCE_ID);
  if (source) {
    source.setData(data);
    return;
  }
  if (recipients.length === 0) return;
  map.addSource(RECIPIENTS_SOURCE_ID, {
    type: 'geojson', cluster: true, clusterMaxZoom: 14, clusterRadius: 50, data,
  });
  map.addLayer({
    id: 'tenant-recipients-clusters',
    type: 'circle',
    source: RECIPIENTS_SOURCE_ID,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#2f9e57',
      'circle-radius': ['step', ['get', 'point_count'], 12, 10, 16, 50, 22],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });
  map.addLayer({
    id: 'tenant-recipients-cluster-count',
    type: 'symbol',
    source: RECIPIENTS_SOURCE_ID,
    filter: ['has', 'point_count'],
    // text-font must name a font this style's glyph server actually serves
    // (the OpenFreeMap Bright style only has Noto Sans). Leaving text-font
    // unset falls back to MapLibre's spec default ("Open Sans Regular"),
    // whose glyph fetch 404s — which silently fails bucket-building for the
    // WHOLE tile shared with the cluster circle layer, not just this label,
    // so the clusters themselves stop rendering too even though they're a
    // separate layer.
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'] },
    paint: { 'text-color': '#ffffff' },
  });
  map.addLayer({
    id: 'tenant-recipients-point',
    type: 'circle',
    source: RECIPIENTS_SOURCE_ID,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': '#2f9e57',
      'circle-radius': 5,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });
}

function fitRecipients(maplibre, map, recipients) {
  if (recipients.length === 0) return;
  const bounds = recipients.reduce(
    (accumulated, recipient) => accumulated.extend([recipient.longitude, recipient.latitude]),
    new maplibre.LngLatBounds()
  );
  map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
}

export function PolygonEditor({ value, onChange, tenantSlug, recipients = NO_RECIPIENTS }) {
  const geolocatedRecipients = useMemo(() => recipients.filter((recipient) => (
    recipient.active === true
    && Number.isFinite(recipient.longitude)
    && recipient.longitude >= -180
    && recipient.longitude <= 180
    && Number.isFinite(recipient.latitude)
    && recipient.latitude >= -90
    && recipient.latitude <= 90
  )), [recipients]);
  const mapView = DEMO_MAP_VIEW_BY_TENANT[tenantSlug] || FALLBACK_MAP_VIEW;
  const hostRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const maplibreRef = useRef(null);
  const recipientsRef = useRef(geolocatedRecipients);
  const mapLoadedRef = useRef(false);
  const fittedRecipientsRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const [status, setStatus] = useState('loading');
  onChangeRef.current = onChange;
  recipientsRef.current = geolocatedRecipients;
  useEffect(() => {
    let map; let draw; let cancelled = false;
    (async () => {
      try {
        const [maplibre] = await Promise.all([
          import('maplibre-gl'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        const { TerraDraw, TerraDrawPolygonMode } = await import('terra-draw');
        const { TerraDrawMapLibreGLAdapter } = await import('terra-draw-maplibre-gl-adapter');
        if (cancelled) return;
        maplibreRef.current = maplibre;
        map = new maplibre.Map({ container: hostRef.current, style: 'https://tiles.openfreemap.org/styles/bright', ...mapView });
        mapRef.current = map;
        map.on('load', () => {
          if (cancelled) return;
          mapLoadedRef.current = true;
          draw = new TerraDraw({ adapter: new TerraDrawMapLibreGLAdapter({ map }), modes: [new TerraDrawPolygonMode()] });
          drawRef.current = draw;
          draw.start();
          draw.setMode('polygon');
          draw.on('finish', (id) => {
            const feature = draw.getSnapshotFeature(id);
            if (feature) onChangeRef.current(feature.geometry);
          });
          setStatus(draw.getMode() === 'polygon' ? 'ready' : 'error');
          syncRecipientClusterLayer(map, recipientsRef.current);
          if (recipientsRef.current.length > 0) {
            fitRecipients(maplibre, map, recipientsRef.current);
            fittedRecipientsRef.current = true;
          }
        });
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      mapLoadedRef.current = false;
      fittedRecipientsRef.current = false;
      draw?.stop();
      map?.remove();
      if (drawRef.current === draw) drawRef.current = null;
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [tenantSlug, mapView]);
  useEffect(() => {
    if (!mapLoadedRef.current || !mapRef.current) return;
    syncRecipientClusterLayer(mapRef.current, geolocatedRecipients);
    if (!fittedRecipientsRef.current && geolocatedRecipients.length > 0 && maplibreRef.current) {
      fitRecipients(maplibreRef.current, mapRef.current, geolocatedRecipients);
      fittedRecipientsRef.current = true;
    }
  }, [geolocatedRecipients]);
  const resetDrawing = (geometry) => {
    drawRef.current?.clear();
    drawRef.current?.setMode('polygon');
    onChange(geometry);
  };
  const resetView = () => {
    if (maplibreRef.current && mapRef.current) fitRecipients(maplibreRef.current, mapRef.current, geolocatedRecipients);
  };
  return <div className="polygon-editor">
    <p>Click the map to add vertices, then click the first point or press Enter to finish the polygon.</p>
    <p className="marker-legend"><span className="recipient-marker" aria-hidden="true" /> active recipient with a mapped location</p>
    <div className="map" ref={hostRef} aria-label="Polygon map" />
    <p className="map-status" role="status">{status === 'loading' ? 'Loading map…' : status === 'error' ? 'Map tiles could not be loaded. Use the demo polygon to continue.' : 'Polygon drawing is ready.'}</p>
    <button type="button" onClick={() => resetDrawing(DEMO_POLYGON)}>Use demo polygon</button>
    <button type="button" onClick={() => resetDrawing(null)}>Clear polygon</button>
    <button type="button" onClick={resetView}>Fit recipients</button>
    {value && <textarea className="geojson-preview" readOnly value={JSON.stringify(value)} aria-label="Polygon GeoJSON" />}
  </div>;
}
