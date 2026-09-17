import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { theme } from '../theme';

export default function AlertBell({ dropUp = false }) {
  const [alerts, setAlerts] = useState([]);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    function fetchAlerts() {
      fetch('/api/notifications')
        .then(r => r.json())
        .then(setAlerts)
        .catch(() => {});
    }
    fetchAlerts();
    const id = setInterval(fetchAlerts, 15000);
    return () => clearInterval(id);
  }, []);

  async function dismiss(id) {
    await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
    setAlerts(prev => prev.filter(a => a.id !== id));
  }

  const count = alerts.length;

  const title = count ? `${count} server alert${count === 1 ? '' : 's'}` : 'No server alerts';

  return (
    <div style={{ position: 'relative', width: dropUp ? '100%' : undefined }}>
      {dropUp ? (
        // Sidebar footer: wide row with the alert count spelled out.
        <button
          onClick={() => setOpen(o => !o)}
          title={title}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            width: '100%',
            background: open ? 'rgba(255,255,255,0.05)' : 'transparent',
            border: 'none',
            borderRadius: 10,
            padding: '7px 8px',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}
        >
          <span style={{
            width: 25,
            height: 25,
            borderRadius: 8,
            background: count ? 'rgba(239, 68, 68, 0.14)' : theme.cardAlt,
            border: `1px solid ${count ? 'rgba(239, 68, 68, 0.35)' : theme.border}`,
            color: count ? '#fca5a5' : theme.textMuted,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: theme.mono,
            fontWeight: 600,
            fontSize: 11,
            flexShrink: 0,
          }}>
            !
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: theme.textStrong }}>System Logs</span>
            <span style={{ fontSize: 9.5, color: theme.textDim }}>
              {count ? `${count} alert${count === 1 ? '' : 's'} pending` : 'no alerts pending'}
            </span>
          </span>
        </button>
      ) : (
        <button
          onClick={() => setOpen(o => !o)}
          title={title}
          style={{
            position: 'relative',
            background: open ? theme.cardAlt : 'transparent',
            border: `1px solid ${count ? '#7f1d1d' : theme.border}`,
            borderRadius: 8,
            color: count ? '#fca5a5' : theme.textDim,
            width: 36,
            height: 36,
            cursor: 'pointer',
            fontSize: 16,
          }}
        >
          !
          {count > 0 && (
            <span style={{
              position: 'absolute',
              top: -6,
              right: -6,
              background: theme.redDeep,
              color: '#fff',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 800,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              {count}
            </span>
          )}
        </button>
      )}
      {open && (
        <div style={{
          position: 'absolute',
          ...(dropUp ? { bottom: 44, left: 0, right: 0, width: 'auto' } : { top: 44, right: 0, width: 280 }),
          maxWidth: dropUp ? 'none' : 'calc(100vw - 24px)',
          background: theme.card,
          border: `1px solid ${theme.border}`,
          borderRadius: 12,
          boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
          zIndex: 40,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${theme.border}`,
            fontSize: 12,
            fontWeight: 700,
            color: theme.textMuted,
          }}>
            Server alerts
          </div>
          {count === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: theme.textDim }}>All clear</div>
          ) : (
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {alerts.map(a => (
                <div key={a.id} style={{
                  padding: '10px 14px',
                  borderBottom: `1px solid ${theme.border}`,
                  fontSize: 12,
                  color: theme.text,
                  lineHeight: 1.45,
                }}>
                  <div>{a.message}</div>
                  <button
                    onClick={() => dismiss(a.id)}
                    style={{
                      marginTop: 6,
                      background: 'transparent',
                      border: 'none',
                      color: theme.accent,
                      cursor: 'pointer',
                      fontSize: 12,
                      padding: 0,
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => { setOpen(false); navigate('/settings?tab=alerts'); }}
            style={{
              width: '100%',
              background: theme.cardAlt,
              border: 'none',
              borderTop: `1px solid ${theme.border}`,
              color: theme.textMuted,
              padding: 10,
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Open Settings
          </button>
        </div>
      )}
    </div>
  );
}
