import { useState, useEffect, useCallback, useRef } from 'react';
import { cameraTransform } from '../cameraTransform';

const SNAPSHOT_REFRESH_MS = 30000;

// A plain snapshot gallery, not the fleet status grid: no color-coded highlighting,
// just an occasional still image per printer. Each printer's camera info (does it
// have one, and its snapshot/stream URLs) is looked up once per page visit: the
// URLs themselves are stable, only the image behind a snapshot URL changes, so the
// snapshot <img> tags get a fresh cache-busting query param on an interval instead
// of a re-fetch. A snapshot request is always single-shot, never the continuous
// MJPEG stream (see useCameraHover.jsx for why that distinction matters), except
// for whichever one card is in live view. Only one card may be live at a time
// (liveViewId): starting live view on a card stops whichever other one was live,
// the same discipline as everywhere else camera bandwidth is handled in this app.
export default function Webcams() {
  const [printers, setPrinters] = useState(null);
  const [cameras, setCameras] = useState({}); // { [printerId]: { available, snapshotUrl, streamUrl } }
  const [refreshedAt, setRefreshedAt] = useState(Date.now());
  const [liveViewId, setLiveViewId] = useState(null);
  const fetchedCameras = useRef(new Set());

  const fetchPrinters = useCallback(async () => {
    const res = await fetch('/api/printers');
    if (res.ok) setPrinters(await res.json());
  }, []);

  useEffect(() => {
    fetchPrinters();
    const interval = setInterval(fetchPrinters, 15000);
    return () => clearInterval(interval);
  }, [fetchPrinters]);

  useEffect(() => {
    if (!printers) return;
    printers.forEach(p => {
      if (fetchedCameras.current.has(p.id)) return;
      fetchedCameras.current.add(p.id);
      fetch(`/api/printers/${p.id}/camera`)
        .then(r => (r.ok ? r.json() : { available: false }))
        .catch(() => ({ available: false }))
        .then(data => setCameras(c => ({ ...c, [p.id]: data })));
    });
  }, [printers]);

  useEffect(() => {
    const interval = setInterval(() => setRefreshedAt(Date.now()), SNAPSHOT_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  if (printers === null) {
    return <div style={{ color: '#64748b', fontSize: 14 }}>Loading...</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>
        Webcams
      </div>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>
        A still snapshot per printer, refreshed every 30 seconds. Click "Watch Live" on any
        one printer for its live feed; only one can be live at a time.
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16,
      }}>
        {printers.map(p => {
          const camera = cameras[p.id];
          const isLive = liveViewId === p.id;
          return (
            <div key={p.id} style={{
              background: '#131720', border: '1px solid #1e2433', borderRadius: 8, padding: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>
                  {p.name}
                </div>
                {camera?.streamUrl && (
                  <button
                    onClick={() => setLiveViewId(isLive ? null : p.id)}
                    style={{
                      background: isLive ? '#2563eb' : 'transparent',
                      color: isLive ? '#fff' : '#94a3b8',
                      border: '1px solid #2d3748', borderRadius: 6,
                      padding: '3px 8px', fontSize: 11, cursor: 'pointer',
                    }}
                  >
                    {isLive ? 'Stop Live View' : 'Watch Live'}
                  </button>
                )}
              </div>
              {isLive ? (
                <img
                  key={camera.streamUrl}
                  src={camera.streamUrl}
                  alt={`${p.name} live feed`}
                  style={{ width: '100%', borderRadius: 4, display: 'block', background: '#0a0f1a', transform: cameraTransform(camera) }}
                />
              ) : camera?.snapshotUrl ? (
                <img
                  src={`${camera.snapshotUrl}${camera.snapshotUrl.includes('?') ? '&' : '?'}_=${refreshedAt}`}
                  alt={`${p.name} snapshot`}
                  style={{ width: '100%', borderRadius: 4, display: 'block', background: '#0a0f1a', transform: cameraTransform(camera) }}
                />
              ) : (
                <div style={{
                  width: '100%', height: 120, borderRadius: 4, background: '#0a0f1a',
                  border: '1px dashed #2d3748', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 12, color: '#475569', textAlign: 'center', padding: 8,
                }}>
                  {camera === undefined
                    ? 'Loading...'
                    : camera.available
                      ? 'No snapshot configured'
                      : 'No camera'}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
