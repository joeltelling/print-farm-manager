import { useState } from 'react';

// Full-screen authentication screens shown by the App gate: first-run Setup,
// Login, and a forced Change Password (one-time / recovery passwords). Dark
// theme, inline styles, matching the rest of the app. See docs/auth.md.

const PAGE = { minHeight: '100vh', background: '#0a0f1a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const CARD = { width: '100%', maxWidth: 360, background: '#131720', border: '1px solid #1e2433', borderRadius: 10, padding: 28 };
const LABEL = { display: 'block', fontSize: 12, color: '#94a3b8', margin: '14px 0 4px' };
const INPUT = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 6, color: '#e2e8f0', fontSize: 14, outline: 'none' };
const BTN = { width: '100%', marginTop: 18, padding: '10px 14px', background: '#2563eb', border: 'none', borderRadius: 6, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const BTN_DISABLED = { ...BTN, background: '#1e293b', color: '#64748b', cursor: 'not-allowed' };
const ERR = { marginTop: 14, padding: '8px 11px', background: '#3f1d1d', border: '1px solid #7f1d1d', borderRadius: 6, color: '#fca5a5', fontSize: 13 };
const TITLE = { fontWeight: 800, fontSize: 18, color: '#e2e8f0' };
const SUB = { fontSize: 13, color: '#64748b', marginTop: 4, marginBottom: 6 };

function Shell({ title, subtitle, children }) {
  return (
    <div style={PAGE}>
      <form style={CARD} onSubmit={(e) => e.preventDefault()}>
        <div style={TITLE}>{title}</div>
        {subtitle && <div style={SUB}>{subtitle}</div>}
        {children}
      </form>
    </div>
  );
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function Login({ onDone }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(''); setBusy(true);
    const { ok, data } = await postJson('/api/auth/login', { username, password });
    setBusy(false);
    if (ok) onDone(); else setError(data.error || 'Login failed');
  }

  return (
    <Shell title="Sign in" subtitle="Print Farm Manager">
      <label style={LABEL}>Username</label>
      <input style={INPUT} value={username} autoFocus autoComplete="username"
        onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <label style={LABEL}>Password</label>
      <input style={INPUT} type="password" value={password} autoComplete="current-password"
        onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      {error && <div style={ERR}>{error}</div>}
      <button style={busy || !username || !password ? BTN_DISABLED : BTN}
        disabled={busy || !username || !password} onClick={submit}>
        {busy ? 'Signing in...' : 'Sign in'}
      </button>
    </Shell>
  );
}

export function Setup({ onDone }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 8;
  const ready = username && password.length >= 8 && password === confirm;

  async function submit() {
    if (!ready) return;
    setError(''); setBusy(true);
    const { ok, data } = await postJson('/api/auth/setup', { username, password });
    setBusy(false);
    if (ok) onDone(); else setError(data.error || 'Setup failed');
  }

  return (
    <Shell title="Create the first admin" subtitle="No accounts exist yet. This becomes the administrator.">
      <label style={LABEL}>Username</label>
      <input style={INPUT} value={username} autoFocus autoComplete="username"
        onChange={(e) => setUsername(e.target.value)} />
      <label style={LABEL}>Password (at least 8 characters)</label>
      <input style={INPUT} type="password" value={password} autoComplete="new-password"
        onChange={(e) => setPassword(e.target.value)} />
      <label style={LABEL}>Confirm password</label>
      <input style={INPUT} type="password" value={confirm} autoComplete="new-password"
        onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      {tooShort && <div style={ERR}>Password must be at least 8 characters.</div>}
      {mismatch && <div style={ERR}>Passwords do not match.</div>}
      {error && <div style={ERR}>{error}</div>}
      <button style={ready && !busy ? BTN : BTN_DISABLED} disabled={!ready || busy} onClick={submit}>
        {busy ? 'Creating...' : 'Create admin'}
      </button>
    </Shell>
  );
}

export function ChangePassword({ onDone }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = current && password.length >= 8 && password === confirm;

  async function submit() {
    if (!ready) return;
    setError(''); setBusy(true);
    const { ok, data } = await postJson('/api/auth/change-password', { current_password: current, new_password: password });
    setBusy(false);
    if (ok) onDone(); else setError(data.error || 'Could not change password');
  }

  return (
    <Shell title="Set a new password" subtitle="Your current password is temporary and must be changed.">
      <label style={LABEL}>Current password</label>
      <input style={INPUT} type="password" value={current} autoFocus autoComplete="current-password"
        onChange={(e) => setCurrent(e.target.value)} />
      <label style={LABEL}>New password (at least 8 characters)</label>
      <input style={INPUT} type="password" value={password} autoComplete="new-password"
        onChange={(e) => setPassword(e.target.value)} />
      <label style={LABEL}>Confirm new password</label>
      <input style={INPUT} type="password" value={confirm} autoComplete="new-password"
        onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      {confirm && password !== confirm && <div style={ERR}>Passwords do not match.</div>}
      {error && <div style={ERR}>{error}</div>}
      <button style={ready && !busy ? BTN : BTN_DISABLED} disabled={!ready || busy} onClick={submit}>
        {busy ? 'Saving...' : 'Save password'}
      </button>
    </Shell>
  );
}

// Wrap window.fetch once so any 401 from a guarded /api call (a session that
// expired mid-use) re-runs the App gate, sending the user back to the login
// screen. Auth endpoints are excluded so a wrong-password 401 stays local.
export function installAuthGuard() {
  if (window.__pfmAuthGuard) return;
  window.__pfmAuthGuard = true;
  const orig = window.fetch;
  window.fetch = async (...args) => {
    const res = await orig(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
        window.dispatchEvent(new Event('authExpired'));
      }
    } catch (_) { /* never break a fetch over the guard */ }
    return res;
  };
}
