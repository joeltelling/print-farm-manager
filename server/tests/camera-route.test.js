const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

jest.mock('axios');
jest.mock('../drivers', () => ({ getDriver: jest.fn() }));

const axios = require('axios');
const { getDriver } = require('../drivers');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      type TEXT DEFAULT 'klipper',
      model TEXT NOT NULL,
      status TEXT DEFAULT 'UNKNOWN',
      is_held INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL);
    INSERT INTO printer_models VALUES ('voron', 'Voron', 'klipper');
    INSERT INTO settings VALUES ('camera_mode', 'snapshot');
  `);

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

beforeEach(() => {
  jest.clearAllMocks();
});

function seedPrinter(type = 'klipper') {
  const r = db.prepare(
    `INSERT INTO printers (name, ip, api_key, type, model, created_at) VALUES (?, '127.0.0.1', '', ?, 'voron', ?)`
  ).run(`Cam_${type}_${Date.now()}`, type, Date.now());
  return r.lastInsertRowid;
}

describe('GET /api/printers/:id/camera', () => {
  test('returns 404 for unknown printer', async () => {
    const res = await request(app).get('/api/printers/99999/camera');
    expect(res.status).toBe(404);
  });

  test('returns available false when the driver has no getCameraInfo', async () => {
    const id = seedPrinter('prusa');
    getDriver.mockReturnValue({ getStatus: async () => ({}) });
    const res = await request(app).get(`/api/printers/${id}/camera`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.mode).toBe('snapshot');
    expect(res.body.snapshotUrl).toBeUndefined();
  });

  test('returns metadata without raw printer URLs when camera exists', async () => {
    const id = seedPrinter('klipper');
    getDriver.mockReturnValue({
      getCameraInfo: async () => ({
        available: true,
        name: 'Bed cam',
        snapshotUrl: 'http://127.0.0.1:8110/?action=snapshot',
        streamUrl: 'http://127.0.0.1:8110/?action=stream',
        rotation: 0,
        flipHorizontal: false,
        flipVertical: false,
      }),
    });
    const res = await request(app).get(`/api/printers/${id}/camera`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      name: 'Bed cam',
      mode: 'snapshot',
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
    });
  });
});

describe('GET /api/printers/:id/camera/snapshot', () => {
  test('returns 404 when camera is unavailable', async () => {
    const id = seedPrinter('prusa');
    getDriver.mockReturnValue({});
    const res = await request(app).get(`/api/printers/${id}/camera/snapshot`);
    expect(res.status).toBe(404);
  });

  test('proxies a JPEG snapshot', async () => {
    const id = seedPrinter('klipper');
    getDriver.mockReturnValue({
      getCameraInfo: async () => ({
        available: true,
        name: 'webcam',
        snapshotUrl: 'http://127.0.0.1:8110/?action=snapshot',
        streamUrl: 'http://127.0.0.1:8110/?action=stream',
      }),
    });
    axios.get.mockResolvedValueOnce({
      data: Buffer.from('fake-jpeg'),
      headers: { 'content-type': 'image/jpeg' },
    });
    const res = await request(app).get(`/api/printers/${id}/camera/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
    expect(axios.get).toHaveBeenCalledWith(
      'http://127.0.0.1:8110/?action=snapshot',
      expect.objectContaining({ responseType: 'arraybuffer', timeout: 8000 })
    );
  });
});
