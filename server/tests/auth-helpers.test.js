// Unit tests for the DB-independent pieces of server/auth.js: password
// hashing, API key generation, and cookie parsing. The session/API-key
// lookup functions (createSession, getUserBySession, getUserByApiKey) need a
// real better-sqlite3 instance and are covered in server/tests/auth-routes.test.js
// instead, via the same in-memory-DB + supertest pattern used elsewhere.

const auth = require('../auth');

describe('hashPassword / verifyPassword', () => {
  test('a correct password verifies against its own hash', () => {
    const hash = auth.hashPassword('correct horse battery staple');
    expect(auth.verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  test('a wrong password does not verify', () => {
    const hash = auth.hashPassword('correct horse battery staple');
    expect(auth.verifyPassword('wrong password', hash)).toBe(false);
  });

  test('two hashes of the same password are not identical (salted)', () => {
    const a = auth.hashPassword('same password');
    const b = auth.hashPassword('same password');
    expect(a).not.toBe(b);
  });

  test('verifyPassword returns false against a null hash (OIDC-only user)', () => {
    expect(auth.verifyPassword('anything', null)).toBe(false);
  });
});

describe('generateApiKey', () => {
  test('plaintext starts with the pfm_ prefix and prefix is a slice of it', () => {
    const { plaintext, prefix } = auth.generateApiKey();
    expect(plaintext.startsWith('pfm_')).toBe(true);
    expect(plaintext.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(plaintext.length);
  });

  test('the stored hash verifies the plaintext it was generated from', () => {
    const { plaintext, hash } = auth.generateApiKey();
    expect(auth.verifyPassword(plaintext, hash)).toBe(true);
  });

  test('two generated keys are never equal', () => {
    const a = auth.generateApiKey();
    const b = auth.generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe('parseCookies', () => {
  test('parses a single cookie', () => {
    const req = { headers: { cookie: 'pfm_session=abc123' } };
    expect(auth.parseCookies(req)).toEqual({ pfm_session: 'abc123' });
  });

  test('parses multiple cookies separated by semicolons', () => {
    const req = { headers: { cookie: 'a=1; b=2;c=3' } };
    expect(auth.parseCookies(req)).toEqual({ a: '1', b: '2', c: '3' });
  });

  test('decodes URI-encoded values', () => {
    const req = { headers: { cookie: 'pfm_oidc_flow=abc%2F123' } };
    expect(auth.parseCookies(req)).toEqual({ pfm_oidc_flow: 'abc/123' });
  });

  test('returns {} when there is no cookie header', () => {
    expect(auth.parseCookies({ headers: {} })).toEqual({});
  });
});

describe('requireAuth middleware', () => {
  function mockDb({ apiKeyUser, sessionUser } = {}) {
    return {
      prepare: (sql) => ({
        get: (...args) => {
          if (sql.includes('FROM api_keys')) return apiKeyUser ? { id: 1, user_id: 42, key_hash: apiKeyUser.__hash } : undefined;
          if (sql.includes('FROM sessions')) return sessionUser || undefined;
          if (sql.includes('FROM users WHERE id')) return apiKeyUser || undefined;
          return undefined;
        },
        all: () => (apiKeyUser ? [{ id: 1, user_id: 42, key_hash: apiKeyUser.__hash }] : []),
        run: () => ({}),
      }),
    };
  }

  test('401s with no Authorization header and no session cookie', () => {
    const db = mockDb();
    const req = { headers: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    auth.requireAuth(db)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401s on a malformed Authorization header', () => {
    const db = mockDb();
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    auth.requireAuth(db)(req, res, next);
    // Falls through to the cookie check, which also fails.
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() and sets req.user when the session cookie resolves a live user', () => {
    const user = { id: 7, email: 'a@b.com', name: 'A', role: 'operator', password_hash: 'x' };
    const db = mockDb({ sessionUser: user });
    const req = { headers: { cookie: 'pfm_session=validtoken' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    auth.requireAuth(db)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.id).toBe(7);
    expect(req.user.password_hash).toBeUndefined(); // publicUser strips it
    expect(req.authMethod).toBe('session');
  });
});

describe('requireRole middleware', () => {
  test('403s when req.user.role does not match', () => {
    const req = { user: { role: 'operator' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    auth.requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when req.user.role matches', () => {
    const req = { user: { role: 'admin' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    auth.requireRole('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
