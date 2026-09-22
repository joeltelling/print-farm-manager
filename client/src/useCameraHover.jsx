import { useState, useCallback, useRef } from 'react';
import { rotationFitTransform, useNaturalSize } from './cameraTransform';

// Shared hover-to-preview behavior for printer camera feeds: used by the
// Dashboard fleet grid and the Webcams page's identical grid (see
// components/FleetStatusGrid.jsx). Fetches GET /api/printers/:id/camera lazily
// on first hover, not for every printer on every fleet poll, and caches the
// result for the rest of this page visit, so re-hovering the same printer is
// instant and a printer with no camera configured never gets refetched after
// the first check. `requested` (a ref, not state) is the in-flight/fetched
// guard: doing that inside the fetch's .then() callback rather than a setState
// updater avoids React 18 StrictMode's double-invoke-to-catch-impurity
// behavior on updater functions, which would otherwise double-fire the request.
export default function useCameraHover() {
  const [cache, setCache] = useState({}); // { [printerId]: { available, streamUrl, snapshotUrl } }
  const [hover, setHover] = useState(null); // { printerId, name, x, y } | null
  const requested = useRef(new Set());

  const onEnter = useCallback((printer, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover({
      printerId: printer.id, name: printer.name,
      loadedMaterial: printer.loaded_material, loadedColor: printer.loaded_color,
      lanes: printer.lanes,
      x: rect.left + rect.width / 2, y: rect.top,
    });

    if (!requested.current.has(printer.id)) {
      requested.current.add(printer.id);
      fetch(`/api/printers/${printer.id}/camera`)
        .then(r => (r.ok ? r.json() : { available: false }))
        .catch(() => ({ available: false }))
        .then(data => setCache(c => ({ ...c, [printer.id]: data })));
    }
  }, []);

  const onLeave = useCallback(() => setHover(null), []);

  const current = hover ? cache[hover.printerId] : null;
  const [natural, onImgLoad] = useNaturalSize();

  // Hover previews only ever show a still snapshot, never the live streamUrl: a
  // hover fires on every mouse pass over the grid, and opening a continuous MJPEG
  // connection (which keeps pulling frames as long as the tooltip is mounted) on
  // that cadence is exactly the kind of silent bandwidth drain this hook exists to
  // avoid. A printer with a camera but no snapshot endpoint shows a text hint
  // instead of falling back to the stream; watching it live stays an explicit
  // action on the printer's own detail page.
  const previewEl = hover && current?.available ? (
    <div
      style={{
        position: 'fixed', left: hover.x, top: hover.y - 8,
        transform: 'translate(-50%, -100%)', zIndex: 2000, pointerEvents: 'none',
      }}
    >
      <div style={{
        background: '#131720', border: '1px solid #334155', borderRadius: 8,
        padding: 6, boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
      }}>
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4, textAlign: 'center' }}>
          {hover.name}
        </div>
        {(hover.lanes?.length > 0 || hover.loadedMaterial || hover.loadedColor) && (
          <div style={{
            fontSize: 11, color: '#7dd3fc', marginBottom: 4, textAlign: 'center',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            {hover.lanes?.length > 0
              ? hover.lanes.map(l => (
                  <span key={l.lane_index}>{[l.material, l.color].filter(Boolean).join(' · ') || '(not set)'}</span>
                ))
              : <span>{[hover.loadedMaterial, hover.loadedColor].filter(Boolean).join(' · ')}</span>}
          </div>
        )}
        {current.snapshotUrl ? (
          <img
            src={current.snapshotUrl}
            alt={`${hover.name} camera`}
            onLoad={onImgLoad}
            style={{
              width: 220, maxWidth: '40vw', height: 'auto',
              borderRadius: 4, display: 'block', background: '#0a0f1a',
              transform: rotationFitTransform(current, natural),
            }}
          />
        ) : (
          <div style={{
            width: 220, maxWidth: '40vw', padding: '10px 8px',
            fontSize: 11, color: '#64748b', textAlign: 'center',
          }}>
            Live view only. Open the printer to watch.
          </div>
        )}
      </div>
    </div>
  ) : null;

  return { onEnter, onLeave, previewEl };
}
