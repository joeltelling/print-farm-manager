const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE calendar_events (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type       TEXT NOT NULL,
      title            TEXT NOT NULL,
      notes            TEXT,
      start_at         INTEGER NOT NULL,
      end_at           INTEGER,
      all_day          INTEGER NOT NULL DEFAULT 1,
      status           TEXT NOT NULL DEFAULT 'planned',
      blocks_dispatch  INTEGER NOT NULL DEFAULT 0,
      project_id       INTEGER REFERENCES projects(id),
      item_sku         TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER,
      printer_id INTEGER,
      status TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER
    );
    CREATE TABLE parts (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT);
  `);

  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/calendar', require('../routes/calendar')(db));
});

const DAY = 24 * 60 * 60 * 1000;

function seedEvent(overrides = {}) {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO calendar_events (
      event_type, title, notes, start_at, end_at, all_day, status,
      blocks_dispatch, project_id, item_sku, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.event_type ?? 'stock_arrival',
    overrides.title ?? 'Test event',
    overrides.notes ?? null,
    overrides.start_at ?? now,
    overrides.end_at ?? null,
    overrides.all_day ?? 1,
    overrides.status ?? 'planned',
    overrides.blocks_dispatch ?? 0,
    overrides.project_id ?? null,
    overrides.item_sku ?? null,
    now,
    now,
  );
  return r.lastInsertRowid;
}

describe('Calendar API', () => {
  test('POST /events creates a stock arrival and returns 201', async () => {
    const start = Date.now();
    const res = await request(app)
      .post('/api/calendar/events')
      .send({
        event_type: 'stock_arrival',
        title: 'PLA arrives',
        start_at: start,
        end_at: start + DAY,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      event_type: 'stock_arrival',
      title: 'PLA arrives',
      blocks_dispatch: 0,
      status: 'planned',
    });
  });

  test('POST /events production_closure defaults to blocks_dispatch=1 and requires end_at', async () => {
    const start = Date.now();
    const missingEnd = await request(app)
      .post('/api/calendar/events')
      .send({
        event_type: 'production_closure',
        title: 'Holiday',
        start_at: start,
      });
    expect(missingEnd.status).toBe(400);
    expect(missingEnd.body.error).toMatch(/end_at/i);

    const ok = await request(app)
      .post('/api/calendar/events')
      .send({
        event_type: 'production_closure',
        title: 'Holiday',
        start_at: start,
        end_at: start + 3 * DAY,
      });
    expect(ok.status).toBe(201);
    expect(ok.body.blocks_dispatch).toBe(1);
  });

  test('POST /events 400 on invalid event_type or empty title', async () => {
    const badType = await request(app)
      .post('/api/calendar/events')
      .send({ event_type: 'party', title: 'x', start_at: Date.now() });
    expect(badType.status).toBe(400);

    const badTitle = await request(app)
      .post('/api/calendar/events')
      .send({ event_type: 'note', title: '  ', start_at: Date.now() });
    expect(badTitle.status).toBe(400);
  });

  test('GET /events filters by range', async () => {
    const base = Date.UTC(2026, 8, 1);
    seedEvent({ title: 'In range', start_at: base + DAY, end_at: base + 2 * DAY });
    seedEvent({ title: 'Out of range', start_at: base + 40 * DAY, end_at: base + 41 * DAY });

    const res = await request(app)
      .get(`/api/calendar/events?from=${base}&to=${base + 10 * DAY}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('In range');
  });

  test('GET /events 400 without from/to', async () => {
    const res = await request(app).get('/api/calendar/events');
    expect(res.status).toBe(400);
  });

  test('PUT /events/:id partial update and 404', async () => {
    const id = seedEvent({ title: 'Before' });
    const res = await request(app)
      .put(`/api/calendar/events/${id}`)
      .send({ title: 'After', status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('After');
    expect(res.body.status).toBe('done');

    const missing = await request(app)
      .put('/api/calendar/events/999')
      .send({ title: 'Nope' });
    expect(missing.status).toBe(404);
  });

  test('DELETE /events/:id and 404', async () => {
    const id = seedEvent();
    const res = await request(app).delete(`/api/calendar/events/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const missing = await request(app).delete('/api/calendar/events/999');
    expect(missing.status).toBe(404);
  });

  test('GET /dispatch-block reports an active production closure', async () => {
    const now = Date.now();
    seedEvent({
      event_type: 'production_closure',
      title: 'Shutdown',
      start_at: now - DAY,
      end_at: now + DAY,
      blocks_dispatch: 1,
    });
    const res = await request(app).get('/api/calendar/dispatch-block');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.block.title).toBe('Shutdown');
  });

  test('GET /dispatch-block ignores cancelled closures', async () => {
    const now = Date.now();
    seedEvent({
      event_type: 'production_closure',
      title: 'Cancelled',
      start_at: now - DAY,
      end_at: now + DAY,
      blocks_dispatch: 1,
      status: 'cancelled',
    });
    const res = await request(app).get('/api/calendar/dispatch-block');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.block).toBeNull();
  });

  test('GET /overview returns derived job items in range', async () => {
    const start = Date.now() - 1000;
    db.prepare(`
      INSERT INTO jobs (id, part_id, printer_id, status, started_at, finished_at, created_at)
      VALUES (1, NULL, NULL, 'finished', ?, ?, ?)
    `).run(start, start + 500, start);
    const res = await request(app)
      .get(`/api/calendar/overview?from=${start - 10000}&to=${start + 10000}`);
    expect(res.status).toBe(200);
    expect(res.body.items.some(i => i.source === 'job' && i.id === 1)).toBe(true);
  });
});
