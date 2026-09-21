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

export default function Login() {
  const { setUser } = useAuth();
  const [status, setStatus] = useState(null); // { needsBootstrap, oidcEnabled }
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/auth/status').then(r => r.json()).then(setStatus).catch(() => setStatus({ needsBootstrap: false, oidcEnabled: false }));
  }, []);

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
      setUser(data);
    } finally {
      setSubmitting(false);
    }
  }

  if (!status) return null;

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
