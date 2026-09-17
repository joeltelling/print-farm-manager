const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE notebook_pages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      accent      TEXT NOT NULL DEFAULT 'lime',
      trashed_at  INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/notebook', require('../routes/notebook')(db));
});

describe('Notebook API', () => {
  test('POST /pages creates a page and returns 201', async () => {
    const res = await request(app)
      .post('/api/notebook/pages')
      .send({ title: 'Setup notes', body: 'Step 1', accent: 'cyan' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Setup notes',
      body: 'Step 1',
      accent: 'cyan',
      trashed_at: null,
    });
  });

  test('POST /pages 400 on empty title or bad accent', async () => {
    const empty = await request(app).post('/api/notebook/pages').send({ title: '  ' });
    expect(empty.status).toBe(400);

    const bad = await request(app)
      .post('/api/notebook/pages')
      .send({ title: 'X', accent: 'pink' });
    expect(bad.status).toBe(400);
  });

  test('GET /pages lists live pages; trashed=1 lists trash', async () => {
    const a = await request(app).post('/api/notebook/pages').send({ title: 'Live' });
    const b = await request(app).post('/api/notebook/pages').send({ title: 'Trash me' });
    await request(app).post(`/api/notebook/pages/${b.body.id}/trash`);

    const live = await request(app).get('/api/notebook/pages');
    expect(live.status).toBe(200);
    expect(live.body.pages.map(p => p.id)).toEqual([a.body.id]);

    const trash = await request(app).get('/api/notebook/pages?trashed=1');
    expect(trash.body.pages.map(p => p.id)).toEqual([b.body.id]);
  });

  test('GET /pages?q= searches title and body', async () => {
    await request(app).post('/api/notebook/pages').send({ title: 'Alpha', body: 'zeta tip' });
    await request(app).post('/api/notebook/pages').send({ title: 'Beta', body: 'other' });

    const byTitle = await request(app).get('/api/notebook/pages?q=Alpha');
    expect(byTitle.body.pages).toHaveLength(1);
    expect(byTitle.body.pages[0].title).toBe('Alpha');

    const byBody = await request(app).get('/api/notebook/pages?q=zeta');
    expect(byBody.body.pages).toHaveLength(1);
    expect(byBody.body.pages[0].title).toBe('Alpha');
  });

  test('PUT /pages/:id updates fields; 404 when missing', async () => {
    const created = await request(app)
      .post('/api/notebook/pages')
      .send({ title: 'Draft' });

    const ok = await request(app)
      .put(`/api/notebook/pages/${created.body.id}`)
      .send({ title: 'Final', body: 'done', accent: 'amber' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: 'Final', body: 'done', accent: 'amber' });

    const emptyBody = await request(app)
      .put(`/api/notebook/pages/${created.body.id}`)
      .send({ body: '' });
    expect(emptyBody.status).toBe(200);
    expect(emptyBody.body.body).toBe('');

    const missing = await request(app)
      .put('/api/notebook/pages/9999')
      .send({ title: 'X' });
    expect(missing.status).toBe(404);
  });

  test('trash / restore cycle; permanent delete only when trashed', async () => {
    const created = await request(app)
      .post('/api/notebook/pages')
      .send({ title: 'Temp' });
    const id = created.body.id;

    const liveDelete = await request(app).delete(`/api/notebook/pages/${id}`);
    expect(liveDelete.status).toBe(409);

    const trashed = await request(app).post(`/api/notebook/pages/${id}/trash`);
    expect(trashed.status).toBe(200);
    expect(trashed.body.trashed_at).not.toBeNull();

    const again = await request(app).post(`/api/notebook/pages/${id}/trash`);
    expect(again.status).toBe(409);

    const restored = await request(app).post(`/api/notebook/pages/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.trashed_at).toBeNull();

    await request(app).post(`/api/notebook/pages/${id}/trash`);
    const gone = await request(app).delete(`/api/notebook/pages/${id}`);
    expect(gone.status).toBe(200);
    expect(db.prepare('SELECT * FROM notebook_pages WHERE id = ?').get(id)).toBeUndefined();
  });
});
