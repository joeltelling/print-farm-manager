/**
 * eBay credential resolution.
 * Env vars EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_REFRESH_TOKEN win over DB.
 * API responses never return full secrets (maskSecret).
 */

const DEFAULT_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
].join(' ');

const HOSTS = {
  sandbox: {
    api: 'https://api.sandbox.ebay.com',
    apiz: 'https://apiz.sandbox.ebay.com',
    token: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
  },
  production: {
    api: 'https://api.ebay.com',
    apiz: 'https://apiz.ebay.com',
    token: 'https://api.ebay.com/identity/v1/oauth2/token',
  },
};

function maskSecret(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (s.length <= 8) return '********';
  return s.slice(0, 4) + '********' + s.slice(-4);
}

function isMaskedPlaceholder(value) {
  if (value == null) return true;
  const s = String(value);
  return s === '' || s.includes('********');
}

function readDbRow(db) {
  return db.prepare('SELECT * FROM ebay_credential WHERE id = 1').get() || null;
}

/**
 * Resolve effective credentials: env overrides DB.
 */
function getCredentials(db) {
  const row = readDbRow(db) || {};
  const environment = process.env.EBAY_ENVIRONMENT
    || row.environment
    || 'sandbox';
  const env = environment === 'production' ? 'production' : 'sandbox';
  const client_id = process.env.EBAY_CLIENT_ID || row.client_id || null;
  const client_secret = process.env.EBAY_CLIENT_SECRET || row.client_secret || null;
  const refresh_token = process.env.EBAY_REFRESH_TOKEN || row.refresh_token || null;
  const marketplace_id = process.env.EBAY_MARKETPLACE_ID || row.marketplace_id || 'EBAY_US';
  const scopes = row.scopes || DEFAULT_SCOPES;
  const auto_post = row.auto_post == null ? 1 : Number(row.auto_post);
  const hosts = HOSTS[env];

  return {
    environment: env,
    client_id,
    client_secret,
    refresh_token,
    marketplace_id,
    scopes,
    auto_post: auto_post ? 1 : 0,
    hosts,
    updated_at: row.updated_at || null,
    source: {
      client_id: process.env.EBAY_CLIENT_ID ? 'env' : (row.client_id ? 'db' : null),
      client_secret: process.env.EBAY_CLIENT_SECRET ? 'env' : (row.client_secret ? 'db' : null),
      refresh_token: process.env.EBAY_REFRESH_TOKEN ? 'env' : (row.refresh_token ? 'db' : null),
    },
  };
}

function hasCredentials(db) {
  const c = getCredentials(db);
  return !!(c.client_id && c.client_secret && c.refresh_token);
}

function getMaskedCredentials(db) {
  const c = getCredentials(db);
  return {
    environment: c.environment,
    marketplace_id: c.marketplace_id,
    scopes: c.scopes,
    auto_post: c.auto_post,
    updated_at: c.updated_at,
    configured: hasCredentials(db),
    client_id: maskSecret(c.client_id),
    client_secret: maskSecret(c.client_secret),
    refresh_token: maskSecret(c.refresh_token),
    source: c.source,
  };
}

/**
 * Upsert credential fields. Masked placeholders leave the stored secret unchanged.
 */
function saveCredentials(db, body) {
  const b = body || {};
  const existing = readDbRow(db) || {};
  const environment = b.environment === 'production' ? 'production' : (b.environment === 'sandbox' ? 'sandbox' : (existing.environment || 'sandbox'));
  const marketplace_id = b.marketplace_id != null
    ? String(b.marketplace_id).trim() || 'EBAY_US'
    : (existing.marketplace_id || 'EBAY_US');
  const scopes = b.scopes != null ? String(b.scopes).trim() || DEFAULT_SCOPES : (existing.scopes || DEFAULT_SCOPES);
  const auto_post = b.auto_post != null ? (b.auto_post ? 1 : 0) : (existing.auto_post == null ? 1 : existing.auto_post);

  const client_id = isMaskedPlaceholder(b.client_id) ? (existing.client_id || null) : String(b.client_id).trim();
  const client_secret = isMaskedPlaceholder(b.client_secret) ? (existing.client_secret || null) : String(b.client_secret).trim();
  const refresh_token = isMaskedPlaceholder(b.refresh_token) ? (existing.refresh_token || null) : String(b.refresh_token).trim();

  const now = Date.now();
  if (existing.id) {
    db.prepare(`
      UPDATE ebay_credential SET
        environment = ?, client_id = ?, client_secret = ?, refresh_token = ?,
        marketplace_id = ?, scopes = ?, auto_post = ?, updated_at = ?
      WHERE id = 1
    `).run(environment, client_id, client_secret, refresh_token, marketplace_id, scopes, auto_post, now);
  } else {
    db.prepare(`
      INSERT INTO ebay_credential
        (id, environment, client_id, client_secret, refresh_token, marketplace_id, scopes, auto_post, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(environment, client_id, client_secret, refresh_token, marketplace_id, scopes, auto_post, now);
  }
  return getMaskedCredentials(db);
}

module.exports = {
  DEFAULT_SCOPES,
  HOSTS,
  maskSecret,
  isMaskedPlaceholder,
  getCredentials,
  hasCredentials,
  getMaskedCredentials,
  saveCredentials,
};
