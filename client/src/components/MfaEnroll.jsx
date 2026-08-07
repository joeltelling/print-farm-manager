import { useState, useEffect } from 'react';
import QRCode from 'qrcode';

// Authenticator-app enrollment: fetch a secret, show a QR + manual key, verify a
// code, then display the one-time recovery codes. Renders a self-contained card
// so it works full-screen (the forced-setup gate) or inline (My Account).

const CARD = { background: '#131720', border: '1px solid #1e2433', borderRadius: 10, padding: 24, maxWidth: 420 };
const INPUT = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 6, color: '#e2e8f0', fontSize: 14 };
const BTN = { marginTop: 14, padding: '10px 14px', background: '#2563eb', border: 'none', borderRadius: 6, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const BTN_OFF = { ...BTN, background: '#1e293b', color: '#64748b', cursor: 'not-allowed' };
const ERR = { marginTop: 12, padding: '8px 11px', background: '#3f1d1d', border: '1px solid #7f1d1d', borderRadius: 6, color: '#fca5a5', fontSize: 13 };
const LABEL = { display: 'block', fontSize: 12, color: '#94a3b8', margin: '14px 0 4px' };

export default function MfaEnroll({ onDone }) {
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [codes, setCodes] = useState(null);

  useEffect(() => {
    fetch('/api/auth/mfa/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.json()).then(d => {
        setSecret(d.secret || '');
        if (d.otpauth_uri) QRCode.toDataURL(d.otpauth_uri, { margin: 1, width: 200 }).then(setQr).catch(() => {});
      }).catch(() => setError('Could not start MFA setup'));
  }, []);

  async function enable() {
    setError('');
    const res = await fetch('/api/auth/mfa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) setCodes(d.recovery_codes || []);
    else setError(d.error || 'Could not enable MFA');
  }

  if (codes) {
    return (
      <div style={CARD}>
        <div style={{ fontWeight: 800, fontSize: 17, color: '#e2e8f0' }}>Save your recovery codes</div>
        <div style={{ fontSize: 13, color: '#64748b', margin: '6px 0 12px' }}>Each works once if you lose your authenticator. They are shown only now, store them somewhere safe.</div>
        <div style={{ background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 6, padding: 12, fontFamily: 'monospace', fontSize: 14, color: '#e2e8f0', lineHeight: 1.9 }}>
          {codes.map(c => <div key={c}>{c}</div>)}
        </div>
        <button style={BTN} onClick={onDone}>I have saved them</button>
      </div>
    );
  }

  return (
    <div style={CARD}>
      <div style={{ fontWeight: 800, fontSize: 17, color: '#e2e8f0' }}>Set up authenticator app</div>
      <div style={{ fontSize: 13, color: '#64748b', margin: '6px 0 12px' }}>Scan with Google Authenticator, 1Password, Authy, or similar, then enter the 6-digit code.</div>
      {qr && <img src={qr} alt="QR code" style={{ width: 200, height: 200, background: '#fff', borderRadius: 6 }} />}
      <div style={{ fontSize: 11, color: '#475569', marginTop: 8, wordBreak: 'break-all' }}>Manual key: <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{secret}</span></div>
      <label style={LABEL}>6-digit code</label>
      <input style={INPUT} value={code} inputMode="numeric" maxLength={6} autoFocus
        onChange={e => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && code.length === 6 && enable()} />
      {error && <div style={ERR}>{error}</div>}
      <button style={code.length === 6 ? BTN : BTN_OFF} disabled={code.length !== 6} onClick={enable}>Enable MFA</button>
    </div>
  );
}
