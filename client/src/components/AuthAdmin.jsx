import { useState, useEffect } from 'react';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';

// Admin-only authentication management, rendered inside the Settings page:
// the access toggle, user accounts, and API tokens (including device tokens
// for a CYD and display tokens for a dashboard viewport). Self-contained: it
// fetches its own data and renders its own toast/confirm. Shown only when the
// current identity is an admin (which includes the disabled-auth pseudo-admin,
// so an operator can set accounts up before turning auth on). See docs/auth.md.

const SECTION = { background: '#1e2433', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640 };
const H2 = { fontSize: 16, fontWeight: 700, marginBottom: 4 };
const HELP = { fontSize: 12, color: '#64748b', marginBottom: 12 };
const INPUT = { background: '#131720', border: '1px solid #2d3748', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 13 };
const BTN = { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const DEL = { background: 'none', border: '1px solid #7f1d1d', borderRadius: 4, color: '#f87171', fontSize: 12, padding: '2px 8px', cursor: 'pointer' };
const TH = { padding: '4px 8px', textAlign: 'left', color: '#64748b', fontSize: 12, fontWeight: 600 };
const TD = { padding: '6px 8px', color: '#e2e8f0', fontSize: 13 };

async function j(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export default function AuthAdmin() {
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();

  const [me, setMe] = useState(null);
  const [users, setUsers] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [settings, setSettings] = useState({});

  // create-user form
  const [nu, setNu] = useState({ username: '', password: '', role: 'operator' });
  // create-token form
  const [nt, setNt] = useState({ name: '', role: 'device', printer_ids: '' });
  const [newSecret, setNewSecret] = useState(null); // shown once after creation

  function reloadAll() {
    fetch('/api/auth/me').then(r => r.json()).then(setMe).catch(() => {});
    fetch('/api/users').then(r => r.ok ? r.json() : []).then(setUsers).catch(() => setUsers([]));
    fetch('/api/tokens').then(r => r.ok ? r.json() : []).then(setTokens).catch(() => setTokens([]));
    fetch('/api/settings').then(r => r.json()).then(setSettings).catch(() => {});
  }
  useEffect(reloadAll, []);

  if (!me || me.role !== 'admin') return null; // not an admin: render nothing

  async function setSetting(key, value, okMsg) {
    const { ok, body } = await j(`/api/settings/${key}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    });
    if (ok) { showToast(okMsg || 'Saved'); reloadAll(); }
    else showToast('Failed: ' + (body.error || 'error'), 'error');
  }

  async function addUser(e) {
    e.preventDefault();
    if (!nu.username || nu.password.length < 8) { showToast('Username and an 8+ char password required', 'error'); return; }
    const { ok, body } = await j('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nu),
    });
    if (ok) { showToast('User created'); setNu({ username: '', password: '', role: 'operator' }); reloadAll(); }
    else showToast('Failed: ' + (body.error || 'error'), 'error');
  }

  async function delUser(u) {
    const go = await confirm({ title: `Delete "${u.username}"?`, message: 'This removes the account and its sessions.', confirmLabel: 'Delete', danger: true });
    if (!go) return;
    const { ok, body } = await j(`/api/users/${u.id}`, { method: 'DELETE' });
    if (ok) { showToast('User deleted'); reloadAll(); } else showToast('Failed: ' + (body.error || 'error'), 'error');
  }

  async function addToken(e) {
    e.preventDefault();
    if (!nt.name) { showToast('Token name required', 'error'); return; }
    const payload = { name: nt.name, role: nt.role };
    if (nt.role === 'device' && nt.printer_ids.trim()) {
      payload.printer_ids = nt.printer_ids.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
    }
    const { ok, body } = await j('/api/tokens', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (ok) { setNewSecret({ name: body.name, token: body.token }); setNt({ name: '', role: 'device', printer_ids: '' }); reloadAll(); }
    else showToast('Failed: ' + (body.error || 'error'), 'error');
  }

  async function delToken(t) {
    const go = await confirm({ title: `Revoke "${t.name}"?`, message: 'The token stops working immediately.', confirmLabel: 'Revoke', danger: true });
    if (!go) return;
    const { ok, body } = await j(`/api/tokens/${t.id}`, { method: 'DELETE' });
    if (ok) { showToast('Token revoked'); reloadAll(); } else showToast('Failed: ' + (body.error || 'error'), 'error');
  }

  return (
    <>
      {/* Access */}
      <section style={SECTION}>
        <h2 style={H2}>Authentication</h2>
        <div style={HELP}>Authentication is required on this install and is always on. Manage who can sign in below.</div>
        <div style={{ marginTop: 4 }}>
          <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Trusted proxies (comma-separated IPs/CIDRs, e.g. the Traefik IP)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ ...INPUT, flex: 1 }} defaultValue={settings.trusted_proxies || ''} id="tp"
              placeholder="192.168.15.30" />
            <button style={BTN} onClick={() => setSetting('trusted_proxies', document.getElementById('tp').value, 'Trusted proxies saved (restart to apply)')}>Save</button>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Dashboard IP allowlist (view the dashboard with no login, e.g. a wall TV)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ ...INPUT, flex: 1 }} defaultValue={settings.dashboard_ip_allowlist || ''} id="dal"
              placeholder="192.168.15.50, 192.168.20.0/24" />
            <button style={BTN} onClick={() => setSetting('dashboard_ip_allowlist', document.getElementById('dal').value, 'Dashboard allowlist saved')}>Save</button>
          </div>
        </div>
      </section>

      {/* Users */}
      <section style={SECTION}>
        <h2 style={H2}>Users</h2>
        <div style={HELP}>Accounts that sign in. Roles: viewer (read only), operator (run the farm), admin (everything).</div>
        {users.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14 }}>
            <thead><tr><th style={TH}>Username</th><th style={TH}>Role</th><th style={TH}>Active</th><th style={TH}></th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid #1a2030' }}>
                  <td style={TD}>{u.username}{u.sso_provider ? ' (SSO)' : ''}</td>
                  <td style={{ ...TD, color: '#94a3b8' }}>{u.role}</td>
                  <td style={{ ...TD, color: u.is_active ? '#4ade80' : '#64748b' }}>{u.is_active ? 'yes' : 'no'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    <button style={DEL} onClick={() => delUser(u)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form onSubmit={addUser} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...INPUT, width: 140 }} placeholder="username" value={nu.username} onChange={e => setNu({ ...nu, username: e.target.value })} />
          <input style={{ ...INPUT, width: 160 }} type="password" placeholder="password (8+)" value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} />
          <select style={INPUT} value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>
            <option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option>
          </select>
          <button type="submit" style={BTN}>Add user</button>
        </form>
      </section>

      {/* API tokens */}
      <section style={SECTION}>
        <h2 style={H2}>API Tokens</h2>
        <div style={HELP}>Machine credentials, not tied to a user. device = a CYD confirming plates (optionally bound to specific printer IDs); display = a read-only dashboard viewport (Apple TV / Android).</div>
        {newSecret && (
          <div style={{ background: '#0a0f1a', border: '1px solid #2563eb', borderRadius: 6, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>Token for "{newSecret.name}" (copy it now, it is shown only once):</div>
            <code style={{ display: 'block', wordBreak: 'break-all', color: '#e2e8f0', fontSize: 13 }}>{newSecret.token}</code>
            <button style={{ ...DEL, borderColor: '#2d3748', color: '#94a3b8', marginTop: 8 }} onClick={() => setNewSecret(null)}>Dismiss</button>
          </div>
        )}
        {tokens.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14 }}>
            <thead><tr><th style={TH}>Name</th><th style={TH}>Role</th><th style={TH}>Printers</th><th style={TH}>Prefix</th><th style={TH}></th></tr></thead>
            <tbody>
              {tokens.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid #1a2030' }}>
                  <td style={TD}>{t.name}</td>
                  <td style={{ ...TD, color: '#94a3b8' }}>{t.role}</td>
                  <td style={{ ...TD, color: '#64748b' }}>{Array.isArray(t.printer_ids) ? t.printer_ids.join(', ') : 'all'}</td>
                  <td style={{ ...TD, color: '#64748b', fontFamily: 'monospace' }}>{t.token_prefix}...</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}><button style={DEL} onClick={() => delToken(t)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form onSubmit={addToken} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...INPUT, width: 160 }} placeholder="token name" value={nt.name} onChange={e => setNt({ ...nt, name: e.target.value })} />
          <select style={INPUT} value={nt.role} onChange={e => setNt({ ...nt, role: e.target.value })}>
            <option value="device">device (CYD)</option>
            <option value="display">display (dashboard)</option>
            <option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option>
          </select>
          {nt.role === 'device' && (
            <input style={{ ...INPUT, width: 150 }} placeholder="printer ids (e.g. 1,2)" value={nt.printer_ids} onChange={e => setNt({ ...nt, printer_ids: e.target.value })} />
          )}
          <button type="submit" style={BTN}>Create token</button>
        </form>
      </section>

      {toastEl}
      {confirmModal}
    </>
  );
}
