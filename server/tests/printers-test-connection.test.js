// Tests for the two no-printer-id-required diagnostic routes: POST
// /api/printers/test-connection (the "Test Connection" button) and POST
// /api/printers/list-cameras (the camera picker on the Add Printer and
// printer-edit forms). Neither touches the database, but mounting the real
// printers router still needs one: it prepares a printer_groups statement at
// setup time (see registerGroup in routes/printers.js), so a stub object throws
// before any request is even sent. Drivers are mocked; the in-memory db exists
// only to satisfy that prepare() call.

jest.mock('../drivers', () => ({
  getDriver: jest.fn(),
}));

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const { getDriver } = require('../drivers');

let app;

beforeEach(() => {
  jest.clearAllMocks();
  const db = new Database(':memory:');
  db.exec('CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
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

describe('POST /api/printers/list-cameras', () => {
  test('400s when ip is missing', async () => {
    const res = await request(app)
      .post('/api/printers/list-cameras')
      .send({ type: 'klipper' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ip/i);
  });

  test('400s when type is missing', async () => {
    const res = await request(app)
      .post('/api/printers/list-cameras')
      .send({ ip: '192.168.1.50' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/i);
  });

  test('400s for an unknown connector type', async () => {
    getDriver.mockImplementation(() => { throw new Error('No driver registered for printer type: "not-a-brand"'); });
    const res = await request(app)
      .post('/api/printers/list-cameras')
      .send({ type: 'not-a-brand', ip: '192.168.1.50' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No driver registered/);
  });

  test('returns an empty list without erroring when the connector has no listCameras support', async () => {
    getDriver.mockReturnValue({ getStatus: jest.fn() }); // no listCameras export
    const res = await request(app)
      .post('/api/printers/list-cameras')
      .send({ type: 'octoprint', ip: '192.168.1.50' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cameras: [] });
  });

  test('passes ip, api_key, and serial_number through to the driver and returns its result', async () => {
    const listCameras = jest.fn().mockResolvedValue([
      { uid: 'uid-1', name: 'cam1', enabled: true },
      { uid: 'uid-2', name: 'cam2', enabled: false },
    ]);
    getDriver.mockReturnValue({ listCameras });

    const res = await request(app)
      .post('/api/printers/list-cameras')
      .send({ type: 'klipper', ip: '192.168.1.70', api_key: '', serial_number: '' });

    expect(res.status).toBe(200);
    expect(res.body.cameras).toHaveLength(2);
    expect(res.body.cameras[0]).toEqual({ uid: 'uid-1', name: 'cam1', enabled: true });
    expect(listCameras).toHaveBeenCalledWith({ ip: '192.168.1.70', api_key: '', serial_number: '' });
  });
});
