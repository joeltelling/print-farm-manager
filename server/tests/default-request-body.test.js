const request = require('supertest');
const express = require('express');

const defaultRequestBody = require('../default-request-body');

// Route handlers in this app destructure req.body directly (`const { ids } = req.body`) and
// answer 400 when a field is missing. These tests mount a handler written that same way on a
// throwaway app, the way the real routers are mounted in the other suites.
function makeApp({ parseJson = false, withFix = true } = {}) {
  const app = express();
  if (parseJson) app.use(express.json());
  if (withFix) app.use(defaultRequestBody);
  app.post('/needs-ids', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    res.json({ ok: true, count: ids.length });
  });
  return app;
}

describe('defaultRequestBody', () => {
  it('turns a missing body into {} so validation answers 400, not a TypeError 500', async () => {
    // No body parser mounted, so req.body is undefined on every Express version: this is the
    // state Express 5 leaves req.body in for a request without a JSON body.
    const res = await request(makeApp()).post('/needs-ids');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'ids array required' });
  });

  it('is what prevents the 500: the same handler without it throws on an undefined body', async () => {
    const res = await request(makeApp({ withFix: false })).post('/needs-ids');
    expect(res.status).toBe(500);
  });

  it('answers 400 for a POST with no Content-Type or body, with express.json() mounted first', async () => {
    const res = await request(makeApp({ parseJson: true })).post('/needs-ids');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'ids array required' });
  });

  it('answers 400 for an empty JSON object body', async () => {
    const res = await request(makeApp({ parseJson: true })).post('/needs-ids').send({});
    expect(res.status).toBe(400);
  });

  it('leaves a real JSON body untouched', async () => {
    const res = await request(makeApp({ parseJson: true })).post('/needs-ids').send({ ids: [1, 2, 3] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 3 });
  });

  it('does not replace a body that a previous middleware already set', async () => {
    const app = express();
    app.use((req, _res, next) => { req.body = { ids: [9] }; next(); });
    app.use(defaultRequestBody);
    app.post('/needs-ids', (req, res) => res.json(req.body));
    const res = await request(app).post('/needs-ids');
    expect(res.body).toEqual({ ids: [9] });
  });

  it('does not swallow malformed JSON: that is still a 400 from express.json()', async () => {
    const res = await request(makeApp({ parseJson: true }))
      .post('/needs-ids')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
  });
});
