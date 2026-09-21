import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';
import { useAuth } from '../AuthContext';

const inputStyle = {
  background: '#1e2433', border: '1px solid #2d3748',
  borderRadius: 5, color: '#e2e8f0', fontSize: 13,
  padding: '6px 9px', outline: 'none', fontFamily: 'inherit',
};

function formatTimestamp(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Account() {
  const { user } = useAuth();
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null); // { key, name }
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();

  const fetchKeys = useCallback(async () => {
    const res = await fetch('/api/api-keys');
    if (res.ok) setKeys(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  async function createKey(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(`Create failed: ${body.error || res.status}`, 'error'); return; }
      setJustCreated(body);
      setName('');
      fetchKeys();
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey(k) {
    const ok = await confirm({
      title: `Revoke "${k.name}"?`,
      message: 'Anything using this key (scripts, OrcaSlicer, automation) will stop working immediately. This cannot be undone.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/api-keys/${k.id}`, { method: 'DELETE' });
    if (!res.ok) { showToast('Revoke failed', 'error'); return; }
    showToast(`"${k.name}" revoked`, 'success');
    fetchKeys();
  }

  if (loading) return <p style={{ color: '#64748b' }}>Loading…</p>;

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: '#e2e8f0', marginBottom: 4 }}>My Account</div>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>{user.name} · {user.email}</div>

      <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        API Keys
      </div>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16, lineHeight: 1.6 }}>
        A key acts as you for any request that uses it: full access, same as being signed in. Use one for scripts or tools that call the API directly (send it as <code style={{ color: '#7dd3fc' }}>Authorization: Bearer &lt;key&gt;</code>).
      </p>

      {justCreated && (
        <div style={{ background: '#14532d', border: '1px solid #22c55e40', borderRadius: 8, padding: '14px 16px', marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>
            "{justCreated.name}" created: copy this key now, it will not be shown again
          </div>
          <code style={{
            display: 'block', background: '#0a0f1a', color: '#e2e8f0', borderRadius: 5,
            padding: '8px 10px', fontSize: 13, wordBreak: 'break-all', userSelect: 'all',
          }}>
            {justCreated.key}
          </code>
          <button
            onClick={() => setJustCreated(null)}
            style={{ marginTop: 10, background: 'none', border: '1px solid #22c55e40', color: '#4ade80', borderRadius: 5, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            Done, I copied it
          </button>
        </div>
      )}

      <form onSubmit={createKey} style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          placeholder="Key name (e.g. OrcaSlicer)"
          value={name}
          onChange={e => setName(e.target.value)}
          disabled={creating}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="submit"
          disabled={creating || !name.trim()}
          style={{
            background: creating || !name.trim() ? '#1e2433' : '#1e40af',
            color: creating || !name.trim() ? '#475569' : '#fff',
            border: 'none', borderRadius: 5, padding: '7px 16px', fontSize: 13, fontWeight: 600,
            cursor: creating || !name.trim() ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {creating ? 'Creating…' : '+ New Key'}
        </button>
      </form>

      {keys.length === 0 ? (
        <p style={{ color: '#475569', fontSize: 13 }}>No API keys yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {keys.map(k => (
            <div key={k.id} style={{
              background: '#131720', border: '1px solid #1e2433', borderRadius: 7,
              padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, opacity: k.revoked_at ? 0.5 : 1,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 600 }}>{k.name}</div>
                <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>{k.key_prefix}…</div>
                <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>
                  Created {formatTimestamp(k.created_at)} · Last used {formatTimestamp(k.last_used_at)}
                </div>
              </div>
              {k.revoked_at ? (
                <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 700 }}>REVOKED</span>
              ) : (
                <button
                  onClick={() => revokeKey(k)}
                  style={{ background: 'none', border: '1px solid #7f1d1d', color: '#fca5a5', borderRadius: 5, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {toastEl}
      {confirmModal}
    </div>
  );
}
