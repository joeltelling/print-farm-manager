import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';
import { useAuth } from '../AuthContext';

const inputStyle = {
  background: '#1e2433', border: '1px solid #2d3748',
  borderRadius: 5, color: '#e2e8f0', fontSize: 13,
  padding: '6px 9px', outline: 'none', fontFamily: 'inherit',
};

const ROLE_META = {
  admin:    { label: 'Admin',    bg: '#78350f', color: '#fcd34d' },
  operator: { label: 'Operator', bg: '#1e3a5f', color: '#93c5fd' },
};

function RoleBadge({ role }) {
  const m = ROLE_META[role] || { label: role, bg: '#1e2433', color: '#64748b' };
  return (
    <span style={{ background: m.bg, color: m.color, borderRadius: 4, padding: '2px 9px', fontSize: 11, fontWeight: 700 }}>
      {m.label}
    </span>
  );
}

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'operator' });
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();

  const fetchUsers = useCallback(async () => {
    const res = await fetch('/api/users');
    if (res.ok) setUsers(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  async function submitAdd(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim(),
          name: form.name.trim(),
          role: form.role,
          password: form.password || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(body.error || `Create failed (${res.status})`); return; }
      setForm({ email: '', name: '', password: '', role: 'operator' });
      setShowAdd(false);
      showToast(`${body.name} added`, 'success');
      fetchUsers();
    } finally {
      setSaving(false);
    }
  }

  async function changeRole(u, role) {
    const res = await fetch(`/api/users/${u.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(`Role change failed: ${body.error || res.status}`, 'error'); return; }
    showToast(`${u.name} is now ${role}`, 'success');
    fetchUsers();
  }

  async function removeUser(u) {
    const ok = await confirm({
      title: `Remove ${u.name}?`,
      message: 'They will be signed out immediately and any API keys they created will stop working.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(`Remove failed: ${body.error || res.status}`, 'error'); return; }
    showToast(`${u.name} removed`, 'success');
    fetchUsers();
  }

  if (loading) return <p style={{ color: '#64748b' }}>Loading…</p>;

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#e2e8f0' }}>Users</div>
        <button
          onClick={() => setShowAdd(s => !s)}
          style={{ background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          {showAdd ? 'Cancel' : '+ Add User'}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={submitAdd} style={{ background: '#131720', border: '1px solid #1e2433', borderRadius: 8, padding: '16px 18px', marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 14px', marginBottom: 10 }}>
            <input placeholder="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} disabled={saving} style={inputStyle} required />
            <input type="email" placeholder="Email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} disabled={saving} style={inputStyle} required />
            <input type="password" placeholder="Password (optional: SSO-only if blank)" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} disabled={saving} style={inputStyle} minLength={8} />
            <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} disabled={saving} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {formError && <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 10 }}>{formError}</div>}
          <button type="submit" disabled={saving} style={{ background: saving ? '#1e2433' : '#1e40af', color: saving ? '#475569' : '#fff', border: 'none', borderRadius: 5, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
            {saving ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {users.map(u => (
          <div key={u.id} style={{
            background: '#131720', border: '1px solid #1e2433', borderRadius: 7,
            padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 600 }}>
                {u.name} {u.id === me.id && <span style={{ color: '#64748b', fontWeight: 400 }}>(you)</span>}
              </div>
              <div style={{ fontSize: 12, color: '#64748b' }}>
                {u.email}{u.oidc_subject ? ' · SSO linked' : ''}
              </div>
            </div>
            <RoleBadge role={u.role} />
            <select
              value={u.role}
              onChange={e => changeRole(u, e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer', fontSize: 12, padding: '4px 8px' }}
            >
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={() => removeUser(u)}
              style={{ background: 'none', border: '1px solid #7f1d1d', color: '#fca5a5', borderRadius: 5, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {toastEl}
      {confirmModal}
    </div>
  );
}
