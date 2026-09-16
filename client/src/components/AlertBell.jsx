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

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={count ? `${count} server alert${count === 1 ? '' : 's'}` : 'No server alerts'}
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
      {open && (
        <div style={{
          position: 'absolute',
          ...(dropUp ? { bottom: 44 } : { top: 44 }),
          right: 0,
          width: 260,
          maxWidth: 'calc(100vw - 24px)',
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
