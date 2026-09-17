import { useState, useEffect, useCallback } from 'react';
import { theme, INPUT_STYLE, BTN_PRIMARY } from '../theme';

// Gates the whole app behind a single local operator account.
//
// Flow: no account yet -> create one (first run) -> logged in but the one-time setup
// guide has not run yet -> onboarding wizard -> the real app. The setup guide never
// reappears unless the account is deleted (Settings > Account, password required),
// which is exactly what re-arms `onboardingCompleted`.
//
// Mounted around <App /> in main.jsx so the rest of the app (and its own polling
// effects) never even mounts until a session exists. See main.jsx for why that
// ordering matters.

const shellStyle = {
  minHeight: '100vh',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: theme.shell,
  padding: 20,
  boxSizing: 'border-box',
};

const cardStyle = {
  background: theme.panel,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radius,
  boxShadow: theme.shadowLift,
  width: '100%',
  maxWidth: 380,
  padding: '32px 30px',
  boxSizing: 'border-box',
};

const labelStyle = { display: 'block', fontSize: 12, color: theme.textMuted, fontWeight: 600, marginBottom: 6 };
const helpStyle = { fontSize: 11.5, color: theme.textDim, marginTop: 4, lineHeight: 1.5 };
const errorStyle = { color: theme.red, fontSize: 13, marginTop: 14, lineHeight: 1.4 };
const titleStyle = { fontSize: 18, fontWeight: 800, color: theme.textBright, textAlign: 'center', marginBottom: 6 };
const subtitleStyle = { fontSize: 13, color: theme.textMuted, textAlign: 'center', marginBottom: 24, lineHeight: 1.5 };

function BrandMark() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
      <div style={{
        width: 48, height: 48, borderRadius: 15, padding: 1,
        background: `linear-gradient(45deg, ${theme.lime} 0%, ${theme.emeraldDeep} 100%)`,
        boxShadow: theme.glowLime,
      }}>
        <div style={{
          width: '100%', height: '100%', borderRadius: 14,
          background: '#11131a',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: theme.mono, fontWeight: 700, fontSize: 14,
          color: theme.lime, letterSpacing: '-0.04em',
        }}>
          CoMa
        </div>
      </div>
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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Settings routes are PUT, not POST (server/routes/settings.js follows the project's
// "updates are PUT, not PATCH" convention). Used by the onboarding wizard below.
async function putJson(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function RegisterScreen({ onDone }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setSubmitting(true);
    try {
      await postJson('/api/auth/register', { username, password });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={shellStyle}>
      <form onSubmit={handleSubmit} style={cardStyle}>
        <BrandMark />
        <div style={titleStyle}>Create the operator account</div>
        <div style={subtitleStyle}>
          First run: set a username and password to protect this CoMa install before it opens.
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Username</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus value={username} onChange={e => setUsername(e.target.value)} style={INPUT_STYLE} required />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            style={INPUT_STYLE}
            minLength={8}
            required
          />
          <div style={helpStyle}>At least 8 characters.</div>
        </div>
        <div style={{ marginBottom: 22 }}>
          <label style={labelStyle}>Confirm password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            style={INPUT_STYLE}
            minLength={8}
            required
          />
        </div>
        <button type="submit" disabled={submitting} style={{ ...BTN_PRIMARY, width: '100%' }}>
          {submitting ? 'Creating account...' : 'Create account and continue'}
        </button>
        {error && <div style={errorStyle}>{error}</div>}
      </form>
    </div>
  );
}

function LoginScreen({ onDone }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await postJson('/api/auth/login', { username, password });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={shellStyle}>
      <form onSubmit={handleSubmit} style={cardStyle}>
        <BrandMark />
        <div style={titleStyle}>Sign in to CoMa</div>
        <div style={subtitleStyle}>Enter your operator credentials to open the fleet.</div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Username</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus value={username} onChange={e => setUsername(e.target.value)} style={INPUT_STYLE} required />
        </div>
        <div style={{ marginBottom: 22 }}>
          <label style={labelStyle}>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={INPUT_STYLE} required />
        </div>
        <button type="submit" disabled={submitting} style={{ ...BTN_PRIMARY, width: '100%' }}>
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
        {error && <div style={errorStyle}>{error}</div>}
      </form>
    </div>
  );
}

// Onboarding only touches settings keys that already exist and are already validated by
// PUT /api/settings/:key (server/routes/settings.js): this wizard is a guided subset of
// the General tab in Settings, not a new source of truth. An empty field is skipped so
// the server's own default stands (e.g. leaving site name blank keeps "CoMa").
const ONBOARDING_STEPS = [
  {
    key: 'farm_name',
    label: 'Site name',
    help: 'Shown in the sidebar. Leave blank to keep the default "CoMa".',
    placeholder: 'CoMa',
    maxLength: 40,
  },
  {
    key: 'dispatch_batch_size',
    label: 'Concurrent printers (1-100)',
    help: 'How many printers the scheduler keeps uploading or printing at once. 10 is a good starting point.',
    placeholder: '10',
    type: 'number',
  },
];

function OnboardingWizard({ onDone }) {
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleFinish(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      for (const step of ONBOARDING_STEPS) {
        const value = values[step.key];
        if (value === undefined || String(value).trim() === '') continue;
        await putJson(`/api/settings/${step.key}`, { value });
      }
      await postJson('/api/auth/complete-onboarding', {});
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={shellStyle}>
      <form onSubmit={handleFinish} style={{ ...cardStyle, maxWidth: 440 }}>
        <BrandMark />
        <div style={titleStyle}>Set up your shopfloor</div>
        <div style={subtitleStyle}>
          One-time guide, shown right after your first login. Everything here can be changed
          later in Settings, and this screen will not appear again unless the account is deleted.
        </div>
        {ONBOARDING_STEPS.map((step, i) => (
          <div key={step.key} style={{ marginBottom: i === ONBOARDING_STEPS.length - 1 ? 22 : 14 }}>
            <label style={labelStyle}>{step.label}</label>
            <input
              type={step.type || 'text'}
              value={values[step.key] ?? ''}
              onChange={e => setValues(v => ({ ...v, [step.key]: e.target.value }))}
              placeholder={step.placeholder}
              maxLength={step.maxLength}
              min={step.type === 'number' ? 1 : undefined}
              max={step.type === 'number' ? 100 : undefined}
              style={INPUT_STYLE}
            />
            <div style={helpStyle}>{step.help}</div>
          </div>
        ))}
        <button type="submit" disabled={submitting} style={{ ...BTN_PRIMARY, width: '100%' }}>
          {submitting ? 'Saving...' : 'Finish setup'}
        </button>
        {error && <div style={errorStyle}>{error}</div>}
      </form>
    </div>
  );
}

export default function AuthGate({ children }) {
  const [status, setStatus] = useState(null); // null = still loading /api/auth/status

  const refresh = useCallback(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(setStatus)
      // A failed status check (e.g. server still starting) is treated as "show the
      // login flow" rather than leaving the screen blank forever.
      .catch(() => setStatus({ hasAccount: false, authenticated: false, onboardingCompleted: false }));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Settings (Account tab) dispatches these instead of holding a reference back into
  // this component, matching the existing cross-page CustomEvent pattern (see
  // farmNameChanged in App.jsx) rather than introducing a context provider.
  useEffect(() => {
    function onAuthChanged() { refresh(); }
    window.addEventListener('authAccountDeleted', onAuthChanged);
    window.addEventListener('authLoggedOut', onAuthChanged);
    return () => {
      window.removeEventListener('authAccountDeleted', onAuthChanged);
      window.removeEventListener('authLoggedOut', onAuthChanged);
    };
  }, [refresh]);

  if (status === null) return <div style={shellStyle} />;
  if (!status.hasAccount) return <RegisterScreen onDone={refresh} />;
  if (!status.authenticated) return <LoginScreen onDone={refresh} />;
  if (!status.onboardingCompleted) return <OnboardingWizard onDone={refresh} />;
  return children;
}
