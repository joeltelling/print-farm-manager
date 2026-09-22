import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';

const cardStyle = {
  background: '#131720', border: '1px solid #1e2433',
  borderRadius: 10, padding: '28px 26px', width: '100%', maxWidth: 380,
};

const labelStyle = {
  display: 'flex', flexDirection: 'column', gap: 5,
  fontSize: 12, fontWeight: 600, color: '#94a3b8',
  marginBottom: 14,
};

const inputStyle = {
  background: '#1e2433', border: '1px solid #2d3748',
  borderRadius: 6, color: '#e2e8f0', fontSize: 14,
  padding: '9px 11px', outline: 'none', fontFamily: 'inherit',
};

const buttonStyle = (disabled) => ({
  width: '100%', background: disabled ? '#1e2433' : '#1e40af',
  color: disabled ? '#475569' : '#fff', border: 'none', borderRadius: 6,
  padding: '10px 14px', fontSize: 14, fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer', marginTop: 4,
});

// /backup-login always shows this form even when auto_sso_redirect is on: the
// escape hatch for when the IdP is down or misconfigured. See docs/auth.md.
const BACKUP_LOGIN_PATH = '/backup-login';

export default function Login({ forceLocal = false }) {
  const { setUser } = useAuth();
  const [status, setStatus] = useState(null); // { needsBootstrap, oidcEnabled, autoSsoRedirect }
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/auth/status').then(r => r.json()).then(setStatus).catch(() => setStatus({ needsBootstrap: false, oidcEnabled: false, autoSsoRedirect: false }));
  }, []);

  // Skip the form entirely and go straight to the IdP once status confirms
  // it's safe to (autoSsoRedirect is already gated server-side on OIDC
  // actually being configured, see routes/auth.js). Never on /backup-login,
  // and never mid-bootstrap (there's no IdP session that maps to "create the
  // first admin").
  const autoRedirecting = !forceLocal && !!status?.autoSsoRedirect && !status?.needsBootstrap;
  useEffect(() => {
    if (autoRedirecting) window.location.href = '/api/auth/oidc/login';
  }, [autoRedirecting]);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const endpoint = status.needsBootstrap ? '/api/auth/bootstrap' : '/api/auth/login';
      const body = status.needsBootstrap ? { email, name, password } : { email, password };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `${status.needsBootstrap ? 'Setup' : 'Sign-in'} failed (${res.status})`);
        return;
      }
      // Login.jsx renders outside the router (see App.jsx: it's returned before
      // BrowserRouter mounts, while logged out), so /backup-login isn't a route
      // React Router knows: once logged in, App re-renders and mounts the
      // router against whatever path is in the address bar. Reset it to '/'
      // first so that lands on the Dashboard instead of a blank, unmatched page.
      if (window.location.pathname === BACKUP_LOGIN_PATH) {
        window.history.replaceState(null, '', '/');
      }
      setUser(data);
    } finally {
      setSubmitting(false);
    }
  }

  if (!status || autoRedirecting) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0a0f1a', padding: 20,
      }}>
        {autoRedirecting && (
          <div style={{ textAlign: 'center', color: '#64748b', fontSize: 13 }}>
            Redirecting to single sign-on…
            <div style={{ marginTop: 10 }}>
              <a href={BACKUP_LOGIN_PATH} style={{ color: '#60a5fa', fontSize: 12 }}>
                Use local sign-in instead
              </a>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0a0f1a', padding: 20,
    }}>
      <form onSubmit={submit} style={cardStyle}>
        <div style={{ fontWeight: 800, fontSize: 18, color: '#e2e8f0', marginBottom: 4 }}>
          {status.needsBootstrap ? 'Create the admin account' : 'Sign in'}
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>
          {status.needsBootstrap
            ? 'No accounts exist yet: this one becomes the first admin.'
            : forceLocal && status.autoSsoRedirect
              ? 'Local sign-in (bypasses single sign-on)'
              : 'Print Farm Manager'}
        </div>

        {status.needsBootstrap && (
          <label style={labelStyle}>
            Name
            <input autoFocus value={name} onChange={e => setName(e.target.value)} disabled={submitting} style={inputStyle} required />
          </label>
        )}
        <label style={labelStyle}>
          Email
          <input type="email" autoFocus={!status.needsBootstrap} value={email} onChange={e => setEmail(e.target.value)} disabled={submitting} style={inputStyle} required />
        </label>
        <label style={labelStyle}>
          Password
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} disabled={submitting} style={inputStyle} required minLength={status.needsBootstrap ? 8 : undefined} />
        </label>

        {error && <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 12 }}>{error}</div>}

        <button type="submit" disabled={submitting} style={buttonStyle(submitting)}>
          {submitting ? 'Please wait…' : status.needsBootstrap ? 'Create account' : 'Sign in'}
        </button>

        {status.oidcEnabled && !status.needsBootstrap && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0', color: '#475569', fontSize: 11 }}>
              <div style={{ flex: 1, height: 1, background: '#1e2433' }} />
              OR
              <div style={{ flex: 1, height: 1, background: '#1e2433' }} />
            </div>
            <a
              href="/api/auth/oidc/login"
              style={{
                display: 'block', textAlign: 'center', width: '100%', boxSizing: 'border-box',
                background: 'transparent', border: '1px solid #2d3748', color: '#e2e8f0',
                borderRadius: 6, padding: '10px 14px', fontSize: 14, fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Sign in with SSO
            </a>
          </>
        )}
      </form>
    </div>
  );
}
