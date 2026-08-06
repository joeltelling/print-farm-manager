import { useState, useEffect } from 'react';
import { useToast } from '../useToast';

// The signed-in user's own account settings: profile details (username, display
// name, email) and a password change. Visible to every authenticated user (not
// just admins). SSO accounts are read-only here (managed by the IdP). Renders
// nothing when auth is disabled or nobody is signed in. See docs/auth.md.

const SECTION = { background: '#1e2433', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640 };
const H2 = { fontSize: 16, fontWeight: 700, marginBottom: 4 };
const HELP = { fontSize: 12, color: '#64748b', marginBottom: 12 };
const LABEL = { fontSize: 12, color: '#94a3b8', display: 'block', margin: '10px 0 4px' };
const INPUT = { background: '#131720', border: '1px solid #2d3748', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 13, width: 240, maxWidth: '100%' };
const BTN = { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginTop: 14 };

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

export default function MyAccount() {
  const [showToast, toastEl] = useToast();
  const [me, setMe] = useState(null);
  const [profile, setProfile] = useState({ username: '', display_name: '', email: '' });
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });

  function load() {
    fetch('/api/auth/me').then(r => r.json()).then(m => {
      setMe(m);
      setProfile({ username: m.username || '', display_name: m.display_name || '', email: m.email || '' });
    }).catch(() => {});
  }
  useEffect(load, []);

  if (!me || !me.authenticated || !me.username) return null; // not signed in (or auth off)
  const editable = !!me.can_edit_profile;

  async function saveProfile(e) {
    e.preventDefault();
    const { ok, body } = await postJson('/api/auth/profile', profile);
    if (ok) { showToast('Profile saved'); window.dispatchEvent(new Event('authChanged')); load(); }
    else showToast('Failed: ' + (body.error || 'error'), 'error');
  }

  async function changePassword(e) {
    e.preventDefault();
    if (pw.next.length < 8) { showToast('New password must be at least 8 characters', 'error'); return; }
    if (pw.next !== pw.confirm) { showToast('Passwords do not match', 'error'); return; }
    const { ok, body } = await postJson('/api/auth/change-password', { current_password: pw.current, new_password: pw.next });
    if (ok) { showToast('Password changed'); setPw({ current: '', next: '', confirm: '' }); }
    else showToast('Failed: ' + (body.error || 'error'), 'error');
  }

  return (
    <>
      <section style={SECTION}>
        <h2 style={H2}>My Account</h2>
        <div style={HELP}>
          Signed in as <span style={{ color: '#e2e8f0' }}>{me.username}</span> ({me.role}){me.type === 'sso' ? ', via SSO' : ''}.
        </div>
        {editable ? (
          <form onSubmit={saveProfile}>
            <label style={LABEL}>Username</label>
            <input style={INPUT} value={profile.username} onChange={e => setProfile({ ...profile, username: e.target.value })} />
            <label style={LABEL}>Display name</label>
            <input style={INPUT} value={profile.display_name} onChange={e => setProfile({ ...profile, display_name: e.target.value })} />
            <label style={LABEL}>Email</label>
            <input style={INPUT} type="email" value={profile.email} onChange={e => setProfile({ ...profile, email: e.target.value })} />
            <div><button type="submit" style={BTN}>Save profile</button></div>
          </form>
        ) : (
          <div style={{ fontSize: 13, color: '#64748b' }}>This account is managed externally (SSO); profile details are set by your identity provider.</div>
        )}
      </section>

      {editable && (
        <section style={SECTION}>
          <h2 style={H2}>Change Password</h2>
          <div style={HELP}>Set a new password for your account.</div>
          <form onSubmit={changePassword}>
            <label style={LABEL}>Current password</label>
            <input style={INPUT} type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} />
            <label style={LABEL}>New password (at least 8 characters)</label>
            <input style={INPUT} type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} />
            <label style={LABEL}>Confirm new password</label>
            <input style={INPUT} type="password" autoComplete="new-password" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} />
            <div><button type="submit" style={BTN}>Change password</button></div>
          </form>
        </section>
      )}
      {toastEl}
    </>
  );
}
