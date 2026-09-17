jest.mock('axios');
const axios = require('axios');
const Database = require('better-sqlite3');
const { ensureErpSchema } = require('../erp/schema');
const {
  saveCredentials,
  getMaskedCredentials,
  maskSecret,
} = require('../ebay/credentials');
const {
  refreshAccessToken,
  ebayRequest,
  clearTokenCache,
  BACKOFF_BASE_MS,
} = require('../ebay/client');

function buildDb() {
  const db = new Database(':memory:');
  ensureErpSchema(db);
  saveCredentials(db, {
    environment: 'sandbox',
    client_id: 'client-abc',
    client_secret: 'secret-xyz',
    refresh_token: 'refresh-tok',
    marketplace_id: 'EBAY_US',
  });
  return db;
}

describe('eBay credentials masking', () => {
  test('maskSecret hides middle of long secrets', () => {
    expect(maskSecret('abcdefghijklmnop')).toMatch(/^abcd\*+mnop$/);
  });

  test('getMaskedCredentials never returns full secrets', () => {
    const db = buildDb();
    const masked = getMaskedCredentials(db);
    expect(masked.configured).toBe(true);
    expect(masked.client_id).toContain('********');
    expect(masked.client_secret).toContain('********');
    expect(masked.refresh_token).toContain('********');
    expect(masked.client_secret).not.toBe('secret-xyz');
    db.close();
  });
});

describe('eBay OAuth client', () => {
  let db;

  beforeEach(() => {
    db = buildDb();
    clearTokenCache();
    jest.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    clearTokenCache();
  });

  test('refreshAccessToken caches the access token', async () => {
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'tok-1', expires_in: 7200 },
    });

    const first = await refreshAccessToken(db);
    expect(first.ok).toBe(true);
    expect(first.accessToken).toBe('tok-1');
    expect(first.cached).toBe(false);

    const second = await refreshAccessToken(db);
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('ebayRequest retries on 429 with backoff', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { access_token: 'tok-1', expires_in: 7200 },
    });

    let calls = 0;
    axios.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { status: 429, data: { errors: [{ message: 'rate limit' }] } };
      return { status: 200, data: { ok: true } };
    });

    const start = Date.now();
    const result = await ebayRequest(db, {
      method: 'GET',
      path: '/sell/account/v1/privilege',
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(BACKOFF_BASE_MS - 50);
  });

  test('refreshAccessToken returns error when credentials missing', async () => {
    const empty = new Database(':memory:');
    ensureErpSchema(empty);
    clearTokenCache();
    const result = await refreshAccessToken(empty);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
    empty.close();
  });
});
