// Tests for server/routes/filaments.js: types CRUD, colors CRUD, and the
// filament_color_types many-to-many join a color's type list is stored in.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE filament_types (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE
    );
    CREATE TABLE filament_colors (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL UNIQUE,
      hex_color TEXT
    );
    CREATE TABLE filament_color_types (
      color_id  INTEGER NOT NULL REFERENCES filament_colors(id),
      type_id   INTEGER NOT NULL REFERENCES filament_types(id),
      PRIMARY KEY (color_id, type_id)
    );
  `);

  app = express();
  app.use(express.json());
  app.use('/api/filaments', require('../routes/filaments')(db));
});

function seedType(name) {
  return db.prepare('INSERT INTO filament_types (name) VALUES (?)').run(name).lastInsertRowid;
}

// ─── Types ──────────────────────────────────────────────────────────────────

describe('GET /api/filaments/types', () => {
  test('returns types ordered by name', async () => {
    seedType('PETG');
    seedType('ASA');
    const res = await request(app).get('/api/filaments/types');
    expect(res.status).toBe(200);
    expect(res.body.map(t => t.name)).toEqual(['ASA', 'PETG']);
  });
});

describe('POST /api/filaments/types', () => {
  test('creates a type', async () => {
    const res = await request(app).post('/api/filaments/types').send({ name: 'PLA' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('PLA');
  });

  test('400s on missing name', async () => {
    const res = await request(app).post('/api/filaments/types').send({});
    expect(res.status).toBe(400);
  });

  test('409s on a duplicate name', async () => {
    seedType('PLA');
    const res = await request(app).post('/api/filaments/types').send({ name: 'PLA' });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/filaments/types/:id', () => {
  test('404s for an unknown id', async () => {
    const res = await request(app).delete('/api/filaments/types/999');
    expect(res.status).toBe(404);
  });

  test('deletes an unused type', async () => {
    const id = seedType('PLA');
    const res = await request(app).delete(`/api/filaments/types/${id}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT * FROM filament_types WHERE id = ?').get(id)).toBeUndefined();
  });

  test('409s when a color is still linked to this type', async () => {
    const typeId = seedType('PLA');
    await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [typeId] });
    const res = await request(app).delete(`/api/filaments/types/${typeId}`);
    expect(res.status).toBe(409);
  });
});

// ─── Colors ─────────────────────────────────────────────────────────────────

describe('POST /api/filaments/colors', () => {
  test('creates a color linked to one type', async () => {
    const typeId = seedType('PLA');
    const res = await request(app).post('/api/filaments/colors').send({ name: 'Black', hex_color: '#000000', type_ids: [typeId] });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Black');
    expect(res.body.types).toEqual([{ id: typeId, name: 'PLA' }]);
  });

  test('creates a color linked to multiple types', async () => {
    const pla = seedType('PLA');
    const petg = seedType('PETG');
    const res = await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [pla, petg] });
    expect(res.status).toBe(201);
    expect(res.body.types.map(t => t.name).sort()).toEqual(['PETG', 'PLA']);
  });

  test('400s on missing name', async () => {
    const typeId = seedType('PLA');
    const res = await request(app).post('/api/filaments/colors').send({ type_ids: [typeId] });
    expect(res.status).toBe(400);
  });

  test('400s on empty type_ids', async () => {
    const res = await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [] });
    expect(res.status).toBe(400);
  });

  test('400s when a type_id does not exist', async () => {
    const res = await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [999] });
    expect(res.status).toBe(400);
  });

  test('409s on a duplicate color name', async () => {
    const typeId = seedType('PLA');
    await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [typeId] });
    const res = await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [typeId] });
    expect(res.status).toBe(409);
  });

  // A hex value missing its leading "#" (or otherwise malformed) is not invalid
  // SQL, so it would previously save silently; as a bare CSS `background` value
  // it's just ignored by the browser, so the swatch never renders with no
  // visible error anywhere. See server/color-distance.js's normalizeHex.
  test('adds a missing leading # instead of saving it unusably', async () => {
    const typeId = seedType('PLA');
    const res = await request(app).post('/api/filaments/colors').send({ name: 'Black', hex_color: 'ff0000', type_ids: [typeId] });
    expect(res.status).toBe(201);
    expect(res.body.hex_color).toBe('#ff0000');
  });

  test('400s on a hex_color that is not a hex color at all', async () => {
    const typeId = seedType('PLA');
    const res = await request(app).post('/api/filaments/colors').send({ name: 'Black', hex_color: 'red', type_ids: [typeId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hex color/i);
  });
});

describe('GET /api/filaments/colors', () => {
  test('returns one flattened row per (color, type) pair', async () => {
    const pla = seedType('PLA');
    const petg = seedType('PETG');
    await request(app).post('/api/filaments/colors').send({ name: 'Black', hex_color: '#000', type_ids: [pla, petg] });

    const res = await request(app).get('/api/filaments/colors');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every(r => r.name === 'Black' && r.hex_color === '#000')).toBe(true);
    expect(res.body.map(r => r.type_name).sort()).toEqual(['PETG', 'PLA']);
  });
});

describe('GET /api/filaments/colors/grouped', () => {
  test('returns one row per color with a nested types array', async () => {
    const pla = seedType('PLA');
    const petg = seedType('PETG');
    await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [pla, petg] });
    await request(app).post('/api/filaments/colors').send({ name: 'Red', type_ids: [pla] });

    const res = await request(app).get('/api/filaments/colors/grouped');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const black = res.body.find(c => c.name === 'Black');
    expect(black.types.map(t => t.name).sort()).toEqual(['PETG', 'PLA']);
    const red = res.body.find(c => c.name === 'Red');
    expect(red.types.map(t => t.name)).toEqual(['PLA']);
  });
});

describe('PUT /api/filaments/colors/:id', () => {
  test('404s for an unknown id', async () => {
    const res = await request(app).put('/api/filaments/colors/999').send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  test('updates name and hex_color without touching types', async () => {
    const typeId = seedType('PLA');
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Black', hex_color: '#000', type_ids: [typeId] });
    const res = await request(app).put(`/api/filaments/colors/${created.body.id}`).send({ hex_color: '#111' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Black');
    expect(res.body.hex_color).toBe('#111');
    expect(res.body.types).toEqual([{ id: typeId, name: 'PLA' }]);
  });

  test('adds a missing leading # on update too', async () => {
    const typeId = seedType('PLA');
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Black', hex_color: '#000', type_ids: [typeId] });
    const res = await request(app).put(`/api/filaments/colors/${created.body.id}`).send({ hex_color: '00ff00' });
    expect(res.status).toBe(200);
    expect(res.body.hex_color).toBe('#00ff00');
  });

  test('400s on update when hex_color is not a hex color at all', async () => {
    const typeId = seedType('PLA');
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Black', hex_color: '#000', type_ids: [typeId] });
    const res = await request(app).put(`/api/filaments/colors/${created.body.id}`).send({ hex_color: 'not-a-color' });
    expect(res.status).toBe(400);
    // Unchanged, not corrupted, by the rejected request
    expect(db.prepare('SELECT hex_color FROM filament_colors WHERE id = ?').get(created.body.id).hex_color).toBe('#000');
  });

  test('clears hex_color when an empty string is sent', async () => {
    const typeId = seedType('PLA');
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Black', hex_color: '#000', type_ids: [typeId] });
    const res = await request(app).put(`/api/filaments/colors/${created.body.id}`).send({ hex_color: '' });
    expect(res.status).toBe(200);
    expect(res.body.hex_color).toBeNull();
  });

  test('replaces the full type list when type_ids is provided', async () => {
    const pla = seedType('PLA');
    const petg = seedType('PETG');
    const abs = seedType('ABS');
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [pla, petg] });

    const res = await request(app).put(`/api/filaments/colors/${created.body.id}`).send({ type_ids: [abs] });
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual([{ id: abs, name: 'ABS' }]);

    const linkCount = db.prepare('SELECT COUNT(*) AS c FROM filament_color_types WHERE color_id = ?').get(created.body.id).c;
    expect(linkCount).toBe(1); // old PLA/PETG links gone, only ABS remains
  });

  test('400s when type_ids is provided but empty (a color needs at least one type)', async () => {
    const typeId = seedType('PLA');
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [typeId] });
    const res = await request(app).put(`/api/filaments/colors/${created.body.id}`).send({ type_ids: [] });
    expect(res.status).toBe(400);
  });

  test('409s renaming into a name that already exists', async () => {
    const typeId = seedType('PLA');
    await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [typeId] });
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Red', type_ids: [typeId] });
    const res = await request(app).put(`/api/filaments/colors/${created.body.id}`).send({ name: 'Black' });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/filaments/colors/:id', () => {
  test('404s for an unknown id', async () => {
    const res = await request(app).delete('/api/filaments/colors/999');
    expect(res.status).toBe(404);
  });

  test('deletes the color and its type links', async () => {
    const typeId = seedType('PLA');
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [typeId] });
    const res = await request(app).delete(`/api/filaments/colors/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT * FROM filament_colors WHERE id = ?').get(created.body.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS c FROM filament_color_types WHERE color_id = ?').get(created.body.id).c).toBe(0);
  });

  test('does not block deleting the type the color used to reference', async () => {
    const typeId = seedType('PLA');
    const created = await request(app).post('/api/filaments/colors').send({ name: 'Black', type_ids: [typeId] });
    await request(app).delete(`/api/filaments/colors/${created.body.id}`);
    const res = await request(app).delete(`/api/filaments/types/${typeId}`);
    expect(res.status).toBe(200);
  });
});
