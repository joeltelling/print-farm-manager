import { useEffect, useState } from 'react';
import { theme, CARD_STYLE } from '../theme';

const SNAPSHOT_MS = 5000;

export default function CameraFeed({ printerId, printerType, printerIp, defaultMode = 'snapshot' }) {
  const [info, setInfo] = useState(null);
  const [mode, setMode] = useState(defaultMode);
  const [tick, setTick] = useState(Date.now());
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/printers/${printerId}/camera`)
      .then(r => r.json())
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        if (data.mode === 'stream' || data.mode === 'snapshot') setMode(data.mode);
      })
      .catch(() => {
        if (!cancelled) setInfo({ available: false });
      });
    return () => { cancelled = true; };
  }, [printerId]);

  useEffect(() => {
    if (mode !== 'snapshot' || !info?.available) return;
    const id = setInterval(() => {
      setTick(Date.now());
      setImgError(false);
    }, SNAPSHOT_MS);
    return () => clearInterval(id);
  }, [mode, info?.available]);

  const nativeUrl = printerIp
    ? `http://${String(printerIp).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
    : null;

  const isLocalSim = (() => {
    const host = String(printerIp || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .split(':')[0]
      .toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  })();

  if (!info) {
    return (
      <div style={{ ...CARD_STYLE, padding: 20, color: theme.textDim, fontSize: 13 }}>
        Loading camera…
      </div>
    );
  }

  if (!info.available) {
    return (
      <div style={{ ...CARD_STYLE, padding: 20 }}>
        <div style={{
          fontSize: 11, color: theme.textFaint, textTransform: 'uppercase',
          letterSpacing: '0.12em', fontWeight: 700, marginBottom: 10,
        }}>
          Camera
        </div>
        <p style={{ color: theme.textMuted, fontSize: 13, margin: '0 0 10px', lineHeight: 1.5 }}>
          Camera is only available for Klipper (Moonraker) printers
          {printerType ? ` (this one is ${printerType})` : ''}.
          Open <strong style={{ color: theme.text }}>Virtual Klipper</strong> in Fleet (group Sim Lab) to see the live simulator feed.
        </p>
        {nativeUrl && (
          <a href={nativeUrl} target="_blank" rel="noopener noreferrer" style={{ color: theme.accent, fontSize: 13 }}>
            Open printer web UI
          </a>
        )}
      </div>
    );
  }

  const src = mode === 'stream'
    ? `/api/printers/${printerId}/camera/stream`
    : `/api/printers/${printerId}/camera/snapshot?t=${tick}`;

  const transform = [
    info.flipHorizontal ? 'scaleX(-1)' : '',
    info.flipVertical ? 'scaleY(-1)' : '',
    info.rotation ? `rotate(${info.rotation}deg)` : '',
  ].filter(Boolean).join(' ');

  return (
    <div style={{ ...CARD_STYLE, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: `1px solid ${theme.border}`,
      }}>
        <div style={{
          fontSize: 11, color: theme.textFaint, textTransform: 'uppercase',
          letterSpacing: '0.12em', fontWeight: 700,
        }}>
          Camera{info.name ? ` · ${info.name}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['snapshot', 'stream'].map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setImgError(false); }}
              style={{
                background: mode === m ? theme.accent : theme.cardAlt,
                color: mode === m ? '#fff' : theme.textMuted,
                border: `1px solid ${mode === m ? theme.accent : theme.border}`,
                borderRadius: 999,
                padding: '3px 10px',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {m === 'snapshot' ? 'Low' : 'Stream'}
            </button>
          ))}
        </div>
      </div>
      <div style={{
        background: '#05080f',
        aspectRatio: '4 / 3',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {imgError ? (
          <div style={{ color: theme.textDim, fontSize: 13, padding: 20, textAlign: 'center' }}>
            Camera feed unavailable. If this is Virtual Klipper, confirm the simulator is running on :8110.
          </div>
        ) : (
          <>
            <img
              src={src}
              alt="Printer camera"
              onError={() => setImgError(true)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                transform: transform || undefined,
              }}
            />
            <div style={{
              position: 'absolute', left: 10, bottom: 10,
              background: 'rgba(5,8,15,0.75)', color: theme.textMuted,
              fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 6,
            }}>
              {isLocalSim
                ? 'Simulator webcam (toolhead plot, not a photo)'
                : mode === 'stream' ? 'Live MJPEG' : 'Snapshot every 5s'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
