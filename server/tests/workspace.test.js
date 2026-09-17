const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;

const SCHEMA = `
  CREATE TABLE workspace_columns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    accent      TEXT NOT NULL DEFAULT 'violet',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE workspace_cards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    column_id   INTEGER NOT NULL REFERENCES workspace_columns(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/workspace', require('../routes/workspace')(db));
});

describe('Workspace API', () => {
  test('GET / seeds four default columns when empty', async () => {
    const res = await request(app).get('/api/workspace');
    expect(res.status).toBe(200);
    expect(res.body.columns).toHaveLength(4);
    expect(res.body.columns.map(c => c.title)).toEqual([
      'Pendiente', 'En curso', 'A revisar', 'Hecho',
    ]);
    expect(res.body.columns.every(c => Array.isArray(c.cards) && c.cards.length === 0)).toBe(true);
  });

  test('GET / re-seeds after last column is deleted', async () => {
    await request(app).get('/api/workspace');
    const cols = db.prepare('SELECT id FROM workspace_columns').all();
    for (const c of cols) {
      await request(app).delete(`/api/workspace/columns/${c.id}`);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_columns').get().n).toBe(0);

    const res = await request(app).get('/api/workspace');
    expect(res.status).toBe(200);
    expect(res.body.columns).toHaveLength(4);
  });

  test('POST /columns creates a column and returns 201', async () => {
    const res = await request(app)
      .post('/api/workspace/columns')
      .send({ title: 'Bloqueado', accent: 'red' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Bloqueado', accent: 'red' });
  });

  test('POST /columns 400 on empty title or bad accent', async () => {
    const empty = await request(app).post('/api/workspace/columns').send({ title: '  ' });
    expect(empty.status).toBe(400);

    const bad = await request(app)
      .post('/api/workspace/columns')
      .send({ title: 'X', accent: 'pink' });
    expect(bad.status).toBe(400);
  });

  test('PUT /columns/:id renames; 404 when missing', async () => {
    await request(app).get('/api/workspace');
    const id = db.prepare('SELECT id FROM workspace_columns ORDER BY sort_order LIMIT 1').get().id;

    const ok = await request(app)
      .put(`/api/workspace/columns/${id}`)
      .send({ title: 'Backlog' });
    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe('Backlog');

    const missing = await request(app)
      .put('/api/workspace/columns/9999')
      .send({ title: 'Nope' });
    expect(missing.status).toBe(404);
  });

  test('PUT /columns/reorder reorders all columns', async () => {
    const board = await request(app).get('/api/workspace');
    const ids = board.body.columns.map(c => c.id).reverse();

    const res = await request(app)
      .put('/api/workspace/columns/reorder')
      .send({ order: ids });
    expect(res.status).toBe(200);
    expect(res.body.columns.map(c => c.id)).toEqual(ids);
  });

  test('POST /cards creates a card; DELETE removes it', async () => {
    const board = await request(app).get('/api/workspace');
    const columnId = board.body.columns[0].id;

    const created = await request(app)
      .post('/api/workspace/cards')
      .send({ column_id: columnId, title: 'Fix nozzle', body: 'MK4S_03' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      column_id: columnId,
      title: 'Fix nozzle',
      body: 'MK4S_03',
    });

    const del = await request(app).delete(`/api/workspace/cards/${created.body.id}`);
    expect(del.status).toBe(200);
    expect(db.prepare('SELECT * FROM workspace_cards WHERE id = ?').get(created.body.id)).toBeUndefined();
  });

  test('POST /cards 400 without title; 404 for unknown column', async () => {
    const noTitle = await request(app)
      .post('/api/workspace/cards')
      .send({ column_id: 1, title: '' });
    expect(noTitle.status).toBe(400);

    const missingCol = await request(app)
      .post('/api/workspace/cards')
      .send({ column_id: 9999, title: 'X' });
    expect(missingCol.status).toBe(404);
  });

  test('PUT /cards/reorder moves a card between columns', async () => {
    const board = await request(app).get('/api/workspace');
    const [colA, colB] = board.body.columns;
    const a = await request(app)
      .post('/api/workspace/cards')
      .send({ column_id: colA.id, title: 'Card A' });
    const b = await request(app)
      .post('/api/workspace/cards')
      .send({ column_id: colA.id, title: 'Card B' });

    const res = await request(app)
      .put('/api/workspace/cards/reorder')
      .send({
        cards: [
          { id: a.body.id, column_id: colB.id, sort_order: 0 },
          { id: b.body.id, column_id: colA.id, sort_order: 0 },
        ],
      });
    expect(res.status).toBe(200);

    const moved = res.body.columns.find(c => c.id === colB.id).cards;
    expect(moved.map(c => c.id)).toEqual([a.body.id]);
    const stayed = res.body.columns.find(c => c.id === colA.id).cards;
    expect(stayed.map(c => c.id)).toEqual([b.body.id]);
  });

  test('PUT /cards/:id updates title and body; 404 when missing', async () => {
    const board = await request(app).get('/api/workspace');
    const created = await request(app)
      .post('/api/workspace/cards')
      .send({ column_id: board.body.columns[0].id, title: 'Old' });

    const ok = await request(app)
      .put(`/api/workspace/cards/${created.body.id}`)
      .send({ title: 'New', body: 'notes' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: 'New', body: 'notes' });

    const missing = await request(app)
      .put('/api/workspace/cards/9999')
      .send({ title: 'X' });
    expect(missing.status).toBe(404);
  });

  test('DELETE /columns cascades cards', async () => {
    const board = await request(app).get('/api/workspace');
    const columnId = board.body.columns[0].id;
    await request(app)
      .post('/api/workspace/cards')
      .send({ column_id: columnId, title: 'Gone' });

    const del = await request(app).delete(`/api/workspace/columns/${columnId}`);
    expect(del.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_cards WHERE column_id = ?').get(columnId).n).toBe(0);
  });
});
