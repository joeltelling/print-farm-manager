const express = require('express');
const router = express.Router();

// Auth-related keys (feat/auth-rbac) join the original operator settings. See docs/auth.md.
// Note: auth_enabled is intentionally NOT writable. Authentication is mandatory
// (always on) in this build, so there is no toggle. See docs/auth.md.
const ALLOWED_KEYS = new Set([
  'dispatch_batch_size', 'farm_name',
  'dashboard_ip_allowlist', 'trusted_proxies',
  'sso_header_enabled', 'sso_header_user', 'sso_header_email', 'sso_header_name',
  'sso_header_groups', 'sso_group_role_map', 'sso_default_role',
  'passkey_rp_id', 'passkey_origin', 'require_mfa',
]);

// Keys where an empty string is a valid value (means "none" / "unset"): a list
// to clear, a header name left blank, etc. Everything else requires a value.
const EMPTY_OK = new Set([
  'dashboard_ip_allowlist', 'trusted_proxies',
  'sso_header_user', 'sso_header_email', 'sso_header_name', 'sso_header_groups',
  'sso_group_role_map', 'passkey_rp_id', 'passkey_origin',
]);

const BOOL_KEYS = new Set(['sso_header_enabled', 'require_mfa']);

// Non-sensitive settings any logged-in user may read (the UI needs them, e.g.
// farm_name for the sidebar). Everything else (auth toggles, trusted proxies,
// SSO mapping, IP allowlists) is admin-only, so it is not leaked to viewers or
// operators via GET /api/settings.
const PUBLIC_SETTING_KEYS = new Set(['farm_name', 'dispatch_batch_size']);

module.exports = (db) => {
  // GET /api/settings returns settings as { key: value, ... }. Admins get the
  // full set; non-admins get only the public keys. (When auth is disabled the
  // middleware treats the caller as admin, so the full set is returned as before.)
  router.get('/', (req, res) => {
    const isAdmin = req.auth && req.auth.role === 'admin';
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    rows.forEach(r => { if (isAdmin || PUBLIC_SETTING_KEYS.has(r.key)) result[r.key] = r.value; });
    res.json(result);
  });

  // PUT /api/settings/:key — update a single setting value
  router.put('/:key', (req, res) => {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown setting key: ${key}` });
    }
    const { value } = req.body;
    if (value === undefined || value === null || (String(value).trim() === '' && !EMPTY_OK.has(key))) {
      return res.status(400).json({ error: 'value is required' });
    }
    const val = String(value);

    if (key === 'dispatch_batch_size') {
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 1 || n > 100) {
        return res.status(400).json({ error: 'dispatch_batch_size must be an integer between 1 and 100' });
      }
    }

    if (key === 'farm_name' && val.trim().length > 40) {
      return res.status(400).json({ error: 'farm_name must be 40 characters or fewer' });
    }

    if (BOOL_KEYS.has(key) && val !== '0' && val !== '1') {
      return res.status(400).json({ error: `${key} must be '0' or '1'` });
    }

    // Trusting a forwarded identity header is only safe behind a trusted proxy;
    // require trusted_proxies to be set first so the header cannot be spoofed.
    if (key === 'sso_header_enabled' && val === '1') {
      const tp = db.prepare("SELECT value FROM settings WHERE key = 'trusted_proxies'").get();
      if (!tp || !tp.value.trim()) {
        return res.status(409).json({ error: 'Set trusted_proxies before enabling SSO header auth' });
      }
    }

    if (key === 'sso_default_role' && val.trim() && !['viewer', 'operator', 'admin'].includes(val.trim())) {
      return res.status(400).json({ error: 'sso_default_role must be viewer, operator, or admin' });
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, val);
    res.json({ key, value: val });
  });

  return router;
};
