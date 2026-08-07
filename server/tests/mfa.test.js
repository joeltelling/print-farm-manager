const mfa = require('../mfa');

// The security-critical core: verify TOTP against the RFC 6238 test vectors so
// the hand-rolled implementation is provably correct, not just plausible.
describe('TOTP core (RFC 6238)', () => {
  const secret = mfa.base32Encode(Buffer.from('12345678901234567890'));

  test('base32 encodes the RFC secret and round-trips', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(mfa.base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  test('6-digit SHA1 codes match the RFC vectors', () => {
    expect(mfa.totpAt(secret, 59 * 1000)).toBe('287082');
    expect(mfa.totpAt(secret, 1111111109 * 1000)).toBe('081804');
    expect(mfa.totpAt(secret, 1234567890 * 1000)).toBe('005924');
    expect(mfa.totpAt(secret, 2000000000 * 1000)).toBe('279037');
  });

  test('verifyTotp accepts the current code and the skew window, rejects others', () => {
    const now = Date.now();
    const code = mfa.totpAt(secret, now);
    expect(mfa.verifyTotp(secret, code, now)).toBe(true);
    expect(mfa.verifyTotp(secret, mfa.totpAt(secret, now - 30000), now)).toBe(true); // one step back
    const wrong = code === '111111' ? '222222' : '111111';
    expect(mfa.verifyTotp(secret, wrong, now)).toBe(false);
    expect(mfa.verifyTotp(secret, 'abc', now)).toBe(false);
    expect(mfa.verifyTotp(secret, '', now)).toBe(false);
  });
});

describe('recovery codes', () => {
  test('generate N formatted codes; hashing ignores formatting/case', () => {
    const codes = mfa.generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);
    expect(codes[0]).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
    const c = codes[0];
    expect(mfa.hashRecoveryCode(c)).toBe(mfa.hashRecoveryCode(c.replace('-', '').toUpperCase()));
    expect(mfa.hashRecoveryCode(codes[0])).not.toBe(mfa.hashRecoveryCode(codes[1]));
  });
});
