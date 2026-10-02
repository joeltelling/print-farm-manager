const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

// ── Shared DB schema ──────────────────────────────────────────────────────────

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      status      TEXT DEFAULT 'draft',
      priority    INTEGER DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL REFERENCES projects(id),
      name          TEXT NOT NULL,
      target_qty    INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'open',
      sort_order    INTEGER NOT NULL DEFAULT 0,
      print_time_seconds INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id         INTEGER NOT NULL REFERENCES parts(id),
      printer_model   TEXT NOT NULL,
      filename        TEXT NOT NULL,
      filepath        TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs  INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE printers (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL,
      ip        TEXT NOT NULL,
      api_key   TEXT NOT NULL,
      model     TEXT NOT NULL,
      status    TEXT DEFAULT 'UNKNOWN',
      is_held   INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id         INTEGER NOT NULL REFERENCES parts(id),
      printer_id      INTEGER NOT NULL REFERENCES printers(id),
      gcode_id        INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status          TEXT DEFAULT 'queued',
      started_at      INTEGER,
      finished_at     INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

// ── PUT /api/projects/reorder ─────────────────────────────────────────────────

describe('PUT /api/projects/reorder', () => {
  let db;
  let app;
  let idA, idB, idC;

  beforeAll(() => {
    db = buildDb();
    app = express();
    app.use(express.json());
    app.use('/api/projects', require('../routes/projects')(db, null));

    const now = Date.now();
    idA = db.prepare("INSERT INTO projects (name, priority, created_at, updated_at) VALUES ('Alpha', 0, ?, ?)").run(now, now).lastInsertRowid;
    idB = db.prepare("INSERT INTO projects (name, priority, created_at, updated_at) VALUES ('Beta',  1, ?, ?)").run(now, now).lastInsertRowid;
    idC = db.prepare("INSERT INTO projects (name, priority, created_at, updated_at) VALUES ('Gamma', 2, ?, ?)").run(now, now).lastInsertRowid;
  });

  test('returns 400 for missing ids', async () => {
    const res = await request(app).put('/api/projects/reorder').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });

  test('returns 400 for empty ids array', async () => {
    const res = await request(app).put('/api/projects/reorder').send({ ids: [] });
    expect(res.status).toBe(400);
  });

  test('assigns priority by array index position', async () => {
    // Move Gamma to top: [C, A, B]
    const res = await request(app)
      .put('/api/projects/reorder')
      .send({ ids: [idC, idA, idB] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(db.prepare('SELECT priority FROM projects WHERE id = ?').get(idC).priority).toBe(0);
    expect(db.prepare('SELECT priority FROM projects WHERE id = ?').get(idA).priority).toBe(1);
    expect(db.prepare('SELECT priority FROM projects WHERE id = ?').get(idB).priority).toBe(2);
  });

  test('GET /api/projects returns projects in priority order', async () => {
    // Set a known order: B=0, C=1, A=2
    await request(app)
      .put('/api/projects/reorder')
      .send({ ids: [idB, idC, idA] });

    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    const names = res.body.map(p => p.name);
    expect(names).toEqual(['Beta', 'Gamma', 'Alpha']);
  });
});

// ── Scheduler dispatch priority ───────────────────────────────────────────────
// Tests that the scheduler's candidate query respects projects.priority.
// We run the query directly against an in-memory DB so there's no network I/O.

describe('Scheduler candidate query — project priority ordering', () => {
  const CANDIDATE_SQL = `
    SELECT
      parts.id          AS part_id,
      parts.target_qty,
      parts.completed_qty,
      parts.project_id,
      gcodes.id         AS gcode_id,
      gcodes.filename,
      gcodes.filepath,
      gcodes.parts_per_plate
    FROM parts
    JOIN gcodes   ON gcodes.part_id    = parts.id
    JOIN projects ON projects.id       = parts.project_id
    WHERE parts.status    = 'open'
      AND projects.status = 'active'
      AND gcodes.printer_model = ?
    ORDER BY projects.priority ASC, projects.created_at ASC, parts.sort_order ASC, parts.created_at ASC
    LIMIT 1
  `;

  let db;

  beforeEach(() => {
    db = buildDb();
    const now = Date.now();

    // Low-priority project (priority = 5) created first
    const lowProjId = db.prepare(
      "INSERT INTO projects (name, status, priority, created_at, updated_at) VALUES ('Low Priority', 'active', 5, ?, ?)"
    ).run(now, now).lastInsertRowid;
    const lowPartId = db.prepare(
      'INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at) VALUES (?, \'Part L\', 100, 0, ?, ?)'
    ).run(lowProjId, now, now).lastInsertRowid;
    db.prepare(
      "INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'mk4s', 'low.bgcode', 'low.bgcode', 4, ?)"
    ).run(lowPartId, now);

    // High-priority project (priority = 1) created second
    const highProjId = db.prepare(
      "INSERT INTO projects (name, status, priority, created_at, updated_at) VALUES ('High Priority', 'active', 1, ?, ?)"
    ).run(now + 1, now + 1).lastInsertRowid;
    const highPartId = db.prepare(
      'INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at) VALUES (?, \'Part H\', 100, 0, ?, ?)'
    ).run(highProjId, now + 1, now + 1).lastInsertRowid;
    db.prepare(
      "INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'mk4s', 'high.bgcode', 'high.bgcode', 4, ?)"
    ).run(highPartId, now + 1);
  });

  test('dispatches the lower-priority-number project first, regardless of creation order', () => {
    const candidate = db.prepare(CANDIDATE_SQL).get('mk4s');
    expect(candidate).toBeDefined();
    expect(candidate.filename).toBe('high.bgcode'); // priority=1 beats priority=5
  });

  test('falls back to created_at when priorities are equal', () => {
    // Set both projects to the same priority
    db.prepare('UPDATE projects SET priority = 0').run();

    const candidate = db.prepare(CANDIDATE_SQL).get('mk4s');
    // Low-priority project was created first (lower created_at), so it wins on tiebreak
    expect(candidate.filename).toBe('low.bgcode');
  });

  test('skips paused projects entirely', () => {
    db.prepare("UPDATE projects SET status = 'paused' WHERE name = 'High Priority'").run();

    const candidate = db.prepare(CANDIDATE_SQL).get('mk4s');
    expect(candidate.filename).toBe('low.bgcode');
  });

  test('returns null when no active projects have a matching gcode', () => {
    db.prepare("UPDATE projects SET status = 'paused'").run();
    const candidate = db.prepare(CANDIDATE_SQL).get('mk4s');
    expect(candidate).toBeUndefined();
  });

  test('respects part sort_order within the same project', () => {
    // Both projects at equal priority — low project wins (created first).
    // Give low project two parts; verify lower sort_order part is picked.
    db.prepare('UPDATE projects SET priority = 0').run();
    const now = Date.now();

    const lowProjId = db.prepare("SELECT id FROM projects WHERE name = 'Low Priority'").get().id;
    const latePartId = db.prepare(
      'INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at) VALUES (?, \'Part L2\', 100, 10, ?, ?)'
    ).run(lowProjId, now + 10, now + 10).lastInsertRowid;
    db.prepare(
      "INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'mk4s', 'low2.bgcode', 'low2.bgcode', 4, ?)"
    ).run(latePartId, now + 10);

    const candidate = db.prepare(CANDIDATE_SQL).get('mk4s');
    // sort_order 0 (low.bgcode) should beat sort_order 10 (low2.bgcode)
    expect(candidate.filename).toBe('low.bgcode');
  });
});
