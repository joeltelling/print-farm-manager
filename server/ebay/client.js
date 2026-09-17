/**
 * eBay REST client: OAuth refresh_token grant, axios calls with retry/backoff.
 * Background paths return { ok: false, error } instead of throwing.
 */
const axios = require('axios');
const { getCredentials, hasCredentials } = require('./credentials');

// Must exceed typical eBay access-token TTL jitter; refresh 60s early so a
 // mid-request expiry cannot race a long inventory push.
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

// Must exceed one eBay rate-limit window slice; three attempts with 1s/2s/4s
// backoff covers transient 429/5xx without blocking the poller for minutes.
const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

let _tokenCache = {
  accessToken: null,
  expiresAt: 0,
  environment: null,
  clientId: null,
};

function clearTokenCache() {
  _tokenCache = { accessToken: null, expiresAt: 0, environment: null, clientId: null };
}

function setSyncState(db, key, value) {
  try {
    db.prepare(
      'INSERT INTO ebay_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value));
  } catch (_) { /* ignore */ }
}

function getSyncState(db, key) {
  try {
    const row = db.prepare('SELECT value FROM ebay_sync_state WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (_) {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function refreshAccessToken(db) {
  const creds = getCredentials(db);
  if (!creds.client_id || !creds.client_secret || !creds.refresh_token) {
    return { ok: false, error: 'eBay credentials not configured' };
  }

  const now = Date.now();
  if (
    _tokenCache.accessToken
    && _tokenCache.expiresAt > now + TOKEN_EXPIRY_MARGIN_MS
    && _tokenCache.environment === creds.environment
    && _tokenCache.clientId === creds.client_id
  ) {
    return { ok: true, accessToken: _tokenCache.accessToken, cached: true };
  }

  const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    scope: creds.scopes,
  });

  try {
    const res = await axios.post(creds.hosts.token, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      const msg = res.data?.error_description || res.data?.error || `token refresh HTTP ${res.status}`;
      setSyncState(db, 'last_token_error', msg);
      clearTokenCache();
      return { ok: false, error: String(msg), status: res.status };
    }

    const accessToken = res.data.access_token;
    const expiresIn = Number(res.data.expires_in) || 7200;
    _tokenCache = {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      environment: creds.environment,
      clientId: creds.client_id,
    };
    setSyncState(db, 'last_token_error', '');
    setSyncState(db, 'last_token_ok_at', String(Date.now()));
    return { ok: true, accessToken, cached: false, expires_in: expiresIn };
  } catch (err) {
    const msg = err.message || String(err);
    setSyncState(db, 'last_token_error', msg);
    clearTokenCache();
    return { ok: false, error: msg };
  }
}

/**
 * Authenticated eBay REST call.
 * @param {object} db
 * @param {{ method?: string, path: string, host?: 'api'|'apiz', params?: object, data?: object, headers?: object }} opts
 */
async function ebayRequest(db, opts) {
  if (!hasCredentials(db)) {
    return { ok: false, error: 'eBay credentials not configured' };
  }

  const creds = getCredentials(db);
  const tokenResult = await refreshAccessToken(db);
  if (!tokenResult.ok) return tokenResult;

  const hostKey = opts.host === 'apiz' ? 'apiz' : 'api';
  const base = creds.hosts[hostKey];
  const url = opts.path.startsWith('http') ? opts.path : `${base}${opts.path}`;
  const method = (opts.method || 'GET').toUpperCase();

  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await axios({
        method,
        url,
        params: opts.params,
        data: opts.data,
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': creds.marketplace_id,
          ...(opts.headers || {}),
        },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });

      if (res.status === 401 && attempt === 0) {
        clearTokenCache();
        const refreshed = await refreshAccessToken(db);
        if (!refreshed.ok) return refreshed;
        tokenResult.accessToken = refreshed.accessToken;
        continue;
      }

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastError = {
          ok: false,
          error: `eBay HTTP ${res.status}`,
          status: res.status,
          data: res.data,
        };
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        const msg = res.data?.errors?.[0]?.message
          || res.data?.error_description
          || res.data?.error
          || `eBay HTTP ${res.status}`;
        return { ok: false, error: String(msg), status: res.status, data: res.data };
      }

      return { ok: true, status: res.status, data: res.data };
    } catch (err) {
      lastError = { ok: false, error: err.message || String(err) };
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  return lastError || { ok: false, error: 'eBay request failed' };
}

async function testConnection(db) {
  const tokenResult = await refreshAccessToken(db);
  if (!tokenResult.ok) return tokenResult;

  // Cheap Account API probe
  const probe = await ebayRequest(db, {
    method: 'GET',
    path: '/sell/account/v1/privilege',
  });
  if (!probe.ok) return probe;
  return {
    ok: true,
    environment: getCredentials(db).environment,
    marketplace_id: getCredentials(db).marketplace_id,
    privilege: probe.data,
    token_cached: !!tokenResult.cached,
  };
}

module.exports = {
  TOKEN_EXPIRY_MARGIN_MS,
  REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  BACKOFF_BASE_MS,
  clearTokenCache,
  setSyncState,
  getSyncState,
  refreshAccessToken,
  ebayRequest,
  testConnection,
};
