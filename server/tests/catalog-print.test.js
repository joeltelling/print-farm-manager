// Tests for POST /api/printers/:id/catalog-print
//
// This handler lives inside server/index.js's listen callback (closure access to db and
// scheduler), so, matching the pattern in set-ready.test.js, a self-contained minimal
// express app replicates it here rather than starting the full server. events.insert is
// inlined as a raw INSERT rather than importing server/events.js, since that module binds
// to the real server/db.js (a live better-sqlite3 connection) at require time.
//
// Cases under test:
//   1. FINISHED with no job: credits completed_qty immediately, unholds, dispatches
//   2. PRINTING with no job: creates the job as 'printing', does NOT touch completed_qty
//      (that happens later through the real, unmodified _handleFinished path)
//   3. Reuses an existing gcode for the Part + printer model instead of duplicating one
//   4. Refuses when a job already owns the printer's current activity (double-submit guard)
//   5. Crediting past target_qty closes the Part and completes the Project

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

function makeApp(db, scheduler = { scheduleForPrinter: jest.fn() }) {
  const app = express();
  app.use(express.json());

  app.post('/api/printers/:id/catalog-print', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const { part_id, parts_per_plate, note } = req.body || {};
    const qty = parseInt(parts_per_plate, 10);
    if (!part_id || !qty || qty < 1) {
      return res.status(400).json({ error: 'part_id and a positive parts_per_plate are required' });
    }

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(part_id);
    if (!part) return res.status(404).json({ error: 'Part not found' });

    if (!['PRINTING', 'FINISHED'].includes(printer.status)) {
      return res.status(409).json({ error: `Printer is ${printer.status}, not PRINTING or FINISHED: nothing to catalog` });
    }
    const hasUnownedActivity = !db.prepare(`
      SELECT 1 FROM jobs WHERE printer_id = ? AND status IN ('uploading', 'printing')
    `).get(printer.id) && !db.prepare(`
      SELECT 1 FROM jobs j WHERE j.printer_id = ? AND j.status = 'finished'
        AND NOT EXISTS (SELECT 1 FROM jobs j2 WHERE j2.printer_id = j.printer_id AND j2.id != j.id AND j2.created_at > j.finished_at)
    `).get(printer.id);
    if (!hasUnownedActivity) {
      return res.status(409).json({ error: 'This printer already has a tracked job: nothing to catalog' });
    }

    const now = Date.now();

    let gcode = db.prepare('SELECT * FROM gcodes WHERE part_id = ? AND printer_model = ?').get(part.id, printer.model);
    if (!gcode) {
      const result = db.prepare(`
        INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
        VALUES (?, ?, ?, '', ?, ?)
      `).run(part.id, printer.model, `External upload via ${printer.name}`, qty, now);
      gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(result.lastInsertRowid);
    }

    const wasFinished = printer.status === 'FINISHED';
    const jobResult = db.prepare(`
      INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(part.id, printer.id, gcode.id, qty, wasFinished ? 'finished' : 'printing', now, wasFinished ? now : null, now);

    db.prepare('INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, ?, ?, ?)')
      .run(printer.id, 'note', `Catalogued externally-started print: part "${part.name}", ${qty}/plate${note ? `, ${note}` : ''}`, now);

    if (wasFinished) {
      db.prepare(`UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?`).run(qty, now, part.id);
      const updatedPart = db.prepare('SELECT * FROM parts WHERE id = ?').get(part.id);
      if (updatedPart.completed_qty >= updatedPart.target_qty && updatedPart.status === 'open') {
        db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, updatedPart.id);
        db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'`).run(updatedPart.id);
        const openCount = db.prepare(`SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'`).get(updatedPart.project_id).count;
        if (openCount === 0) {
          db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, updatedPart.project_id);
        }
      }
      db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(printer.id);
      const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
      scheduler.scheduleForPrinter(updated);
      return res.json(updated);
    }

    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id));
  });

  return app;
}

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, ip TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'mk4s', status TEXT DEFAULT 'UNKNOWN', is_held INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id), gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued', started_at INTEGER,
      finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      note TEXT, created_at INTEGER NOT NULL
    );
  `);
});

function seed({ printerStatus = 'FINISHED', isHeld = 1 } = {}) {
  const now = Date.now();
  const printerId = db.prepare(
    'INSERT INTO printers (name, ip, model, status, is_held, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('MK4S_01', '192.168.1.10', 'mk4s', printerStatus, isHeld, now).lastInsertRowid;
  const projectId = db.prepare(
    "INSERT INTO projects (name, status, created_at, updated_at) VALUES (?, 'active', ?, ?)"
  ).run('Test Project', now, now).lastInsertRowid;
  const partId = db.prepare(
    'INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(projectId, 'Left Bracket', 100, 90, 'open', now, now).lastInsertRowid;
  return { printerId, projectId, partId };
}

describe('POST /api/printers/:id/catalog-print', () => {
  test('FINISHED with no job: credits completed_qty, unholds, and dispatches', async () => {
    const { printerId, partId } = seed({ printerStatus: 'FINISHED', isHeld: 1 });
    const scheduler = { scheduleForPrinter: jest.fn() };
    const app = makeApp(db, scheduler);

    const res = await request(app).post(`/api/printers/${printerId}/catalog-print`).send({ part_id: partId, parts_per_plate: 5 });
    expect(res.status).toBe(200);
    expect(res.body.is_held).toBe(0);

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(95);
    expect(scheduler.scheduleForPrinter).toHaveBeenCalledTimes(1);

    const job = db.prepare('SELECT * FROM jobs WHERE printer_id = ?').get(printerId);
    expect(job.status).toBe('finished');
    expect(job.parts_per_plate).toBe(5);
  });

  test('PRINTING with no job: creates a printing job but does not touch completed_qty or the hold', async () => {
    const { printerId, partId } = seed({ printerStatus: 'PRINTING', isHeld: 0 });
    const scheduler = { scheduleForPrinter: jest.fn() };
    const app = makeApp(db, scheduler);

    const res = await request(app).post(`/api/printers/${printerId}/catalog-print`).send({ part_id: partId, parts_per_plate: 5 });
    expect(res.status).toBe(200);
    expect(res.body.is_held).toBe(0);
    expect(scheduler.scheduleForPrinter).not.toHaveBeenCalled();

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(90); // unchanged

    const job = db.prepare('SELECT * FROM jobs WHERE printer_id = ?').get(printerId);
    expect(job.status).toBe('printing');
    expect(job.finished_at).toBeNull();
  });

  test('reuses an existing gcode for this Part + printer model instead of creating a duplicate', async () => {
    const { printerId, partId } = seed();
    db.prepare(`
      INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
      VALUES (?, 'mk4s', 'existing.bgcode', '/gcode/existing.bgcode', 4, ?)
    `).run(partId, Date.now());

    const app = makeApp(db);
    await request(app).post(`/api/printers/${printerId}/catalog-print`).send({ part_id: partId, parts_per_plate: 5 });

    const gcodeCount = db.prepare('SELECT COUNT(*) c FROM gcodes WHERE part_id = ?').get(partId).c;
    expect(gcodeCount).toBe(1);
    const job = db.prepare('SELECT * FROM jobs WHERE printer_id = ?').get(printerId);
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(job.gcode_id);
    expect(gcode.filename).toBe('existing.bgcode');
  });

  test('refuses when the printer already has a tracked job (double-submit guard)', async () => {
    const { printerId, partId } = seed({ printerStatus: 'PRINTING' });
    db.prepare(`
      INSERT INTO jobs (part_id, printer_id, parts_per_plate, status, started_at, created_at)
      VALUES (?, ?, 5, 'printing', ?, ?)
    `).run(partId, printerId, Date.now(), Date.now());

    const app = makeApp(db);
    const res = await request(app).post(`/api/printers/${printerId}/catalog-print`).send({ part_id: partId, parts_per_plate: 5 });
    expect(res.status).toBe(409);
  });

  test('refuses for a printer that is IDLE (nothing to catalog)', async () => {
    const { printerId, partId } = seed({ printerStatus: 'IDLE' });
    const app = makeApp(db);
    const res = await request(app).post(`/api/printers/${printerId}/catalog-print`).send({ part_id: partId, parts_per_plate: 5 });
    expect(res.status).toBe(409);
  });

  test('crediting past target_qty closes the Part and completes the Project', async () => {
    const { printerId, projectId, partId } = seed({ printerStatus: 'FINISHED' });
    // completed_qty starts at 90/100; crediting 15 pushes it to 105, over target.
    const app = makeApp(db);
    const res = await request(app).post(`/api/printers/${printerId}/catalog-print`).send({ part_id: partId, parts_per_plate: 15 });
    expect(res.status).toBe(200);

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(105);
    expect(part.status).toBe('closed');

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('completed');
  });

  test('400s when parts_per_plate is missing or not positive', async () => {
    const { printerId, partId } = seed();
    const app = makeApp(db);
    const res = await request(app).post(`/api/printers/${printerId}/catalog-print`).send({ part_id: partId, parts_per_plate: 0 });
    expect(res.status).toBe(400);
  });

  test('404s for an unknown printer', async () => {
    const { partId } = seed();
    const app = makeApp(db);
    const res = await request(app).post('/api/printers/999/catalog-print').send({ part_id: partId, parts_per_plate: 5 });
    expect(res.status).toBe(404);
  });

  test('404s for an unknown part', async () => {
    const { printerId } = seed();
    const app = makeApp(db);
    const res = await request(app).post(`/api/printers/${printerId}/catalog-print`).send({ part_id: 999, parts_per_plate: 5 });
    expect(res.status).toBe(404);
  });
});
