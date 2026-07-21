const request = require('supertest');
const express = require('express');

const applySecurityHeaders = require('../security-headers');

let app;

beforeAll(() => {
  app = express();
  applySecurityHeaders(app);
  app.get('/probe', (_req, res) => res.json({ ok: true }));
});

describe('security headers', () => {
  it('does not upgrade-insecure-requests, since the app is served over plain HTTP on the LAN', async () => {
    const res = await request(app).get('/probe');
    expect(res.headers['content-security-policy']).not.toMatch(/upgrade-insecure-requests/);
  });

  it('sets a CSP allowing self + the app\'s known inline-style/font needs', async () => {
    const res = await request(app).get('/probe');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain('font-src \'self\' https://fonts.gstatic.com');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('does not send Strict-Transport-Security, since HSTS is meaningless over plain HTTP', async () => {
    const res = await request(app).get('/probe');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('suppresses X-Powered-By', async () => {
    const res = await request(app).get('/probe');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('denies geolocation/camera/microphone/payment/usb via Permissions-Policy', async () => {
    const res = await request(app).get('/probe');
    expect(res.headers['permissions-policy']).toBe(
      'geolocation=(), camera=(), microphone=(), payment=(), usb=()'
    );
  });
});
