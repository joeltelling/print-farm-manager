// Tests for POST /api/printers/test-connection: the "Test Connection" button's
// backend. It never touches the database (no printer needs to exist to test
// connection settings against it), so drivers are mocked and `db` is unused.

jest.mock('../drivers', () => ({
  getDriver: jest.fn(),
}));

const request  = require('supertest');
const express  = require('express');
const { getDriver } = require('../drivers');

let app;

beforeEach(() => {
  jest.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')({}));
});

describe('POST /api/printers/test-connection', () => {
  test('400s when ip is missing', async () => {
    const res = await request(app)
      .post('/api/printers/test-connection')
      .send({ type: 'octoprint' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ip/i);
  });

  test('400s when type is missing', async () => {
    const res = await request(app)
      .post('/api/printers/test-connection')
      .send({ ip: '192.168.1.50' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/i);
  });

  test('400s for an unknown connector type', async () => {
    getDriver.mockImplementation(() => { throw new Error('No driver registered for printer type: "not-a-brand"'); });
    const res = await request(app)
      .post('/api/printers/test-connection')
      .send({ type: 'not-a-brand', ip: '192.168.1.50' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No driver registered/);
  });

  test('returns ok:false without erroring when the connector has no testConnection support', async () => {
    getDriver.mockReturnValue({ getStatus: jest.fn() }); // no testConnection export
    const res = await request(app)
      .post('/api/printers/test-connection')
      .send({ type: 'prusa', ip: '192.168.1.50' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/not supported/i);
  });

  test('passes ip, api_key, and serial_number through to the driver and returns its result', async () => {
    const testConnection = jest.fn().mockResolvedValue({ ok: true, message: 'Connected' });
    getDriver.mockReturnValue({ testConnection });

    const res = await request(app)
      .post('/api/printers/test-connection')
      .send({ type: 'bambu', ip: '192.168.1.60', api_key: 'CODE123', serial_number: 'SN1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'Connected' });
    expect(testConnection).toHaveBeenCalledWith({ ip: '192.168.1.60', api_key: 'CODE123', serial_number: 'SN1' });
  });

  test('defaults api_key and serial_number to empty strings when omitted', async () => {
    const testConnection = jest.fn().mockResolvedValue({ ok: false, message: 'Connection timed out' });
    getDriver.mockReturnValue({ testConnection });

    const res = await request(app)
      .post('/api/printers/test-connection')
      .send({ type: 'klipper', ip: '192.168.1.70' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, message: 'Connection timed out' });
    expect(testConnection).toHaveBeenCalledWith({ ip: '192.168.1.70', api_key: '', serial_number: '' });
  });
});
