// Tests for POST /api/printers/:id/set-ready
//
// The set-ready handler lives inside server/index.js's listen callback and has
// closure access to db and scheduler, so we build a self-contained minimal
// express app here rather than starting the full server.
//
// Cases under test:
//   1. Normal finish      — job is 'finished'; operator may adjust qty via confirmed_qty
//   2. Missed finish      — job is still 'printing' (server was down when print completed)
//   3. MQTT recovery      — job was marked 'failed' by a transient MQTT disconnect but
//                           the printer finished successfully; count must still be credited
//   4. Upload stalled     — job is 'uploading'; operator confirms it is actually printing
//   5. Offline recovery   — printer went OFFLINE with a printing job (old finished job
//                           also in DB from prior cycle); printing job must be credited,
//                           not silently shadowed by the old finished job

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

// ── Minimal express app that replicates the set-ready route ──────────────────

function makeApp(db, scheduler = { scheduleForPrinter: jest.fn(), startedAt: 0 }) {
  const app = express();
  app.use(express.json());

  app.post('/api/printers/:id/set-ready', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const { confirmed_qty } = req.body || {};
    const now = Date.now();

    // A printing job takes priority over any old finished job from a prior cycle.
    // Without this check, set-ready would find the stale finished job, take the
    // "already credited" normal path, release the hold — and then _dispatchToPrinter
    // would find the stale printing job and auto-fail it.
    const printingJobEarly = db.prepare(
      "SELECT id FROM jobs WHERE printer_id = ? AND status = 'printing' ORDER BY started_at DESC LIMIT 1"
    ).get(printer.id);

    let finishedJob = printingJobEarly ? null : db.prepare(`
      SELECT * FROM jobs WHERE printer_id = ? AND status = 'finished'
      ORDER BY finished_at DESC LIMIT 1
    `).get(printer.id);

    // A cancelled job newer than the last finished one means the printer was stopped
    // after its last normal finish — the stopped job is the one being confirmed, not
    // a qty delta against the older finished job.
    if (finishedJob) {
      const newerCancelled = db.prepare(`
        SELECT 1 FROM jobs WHERE printer_id = ? AND status = 'cancelled' AND finished_at > ? LIMIT 1
      `).get(printer.id, finishedJob.finished_at);
      if (newerCancelled) finishedJob = null;
    }

    if (finishedJob) {
      if (confirmed_qty != null) {
        const confirmedQty = parseInt(confirmed_qty, 10);
        if (!isNaN(confirmedQty) && confirmedQty !== finishedJob.parts_per_plate) {
          const delta = confirmedQty - finishedJob.parts_per_plate;
          db.prepare(`
            UPDATE parts SET completed_qty = MAX(0, completed_qty + ?), updated_at = ? WHERE id = ?
          `).run(delta, now, finishedJob.part_id);

          const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(finishedJob.part_id);
          if (part.completed_qty < part.target_qty && part.status === 'closed') {
            db.prepare(`UPDATE parts SET status = 'open', updated_at = ? WHERE id = ?`).run(now, part.id);
          } else if (part.completed_qty >= part.target_qty && part.status === 'open') {
            db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
          }
        }
      }
    } else {
      const printingJob = db.prepare(`
        SELECT * FROM jobs WHERE printer_id = ? AND status = 'printing'
        ORDER BY started_at DESC LIMIT 1
      `).get(printer.id);

      const activeJob = printingJob
        || db.prepare(`
            SELECT * FROM jobs WHERE printer_id = ? AND status = 'failed' AND finished_at > ?
            ORDER BY finished_at DESC LIMIT 1
          `).get(printer.id, scheduler.startedAt)
        || db.prepare(`
            SELECT * FROM jobs WHERE printer_id = ? AND status = 'cancelled'
            ORDER BY finished_at DESC LIMIT 1
          `).get(printer.id);

      if (activeJob) {
        const creditQty = (confirmed_qty != null && !isNaN(parseInt(confirmed_qty, 10)))
          ? parseInt(confirmed_qty, 10)
          : activeJob.parts_per_plate;

        db.prepare(`UPDATE jobs SET status = 'finished', finished_at = ? WHERE id = ?`)
          .run(now, activeJob.id);

        db.prepare(`
          UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?
        `).run(creditQty, now, activeJob.part_id);

        const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(activeJob.part_id);

        if (part.completed_qty >= part.target_qty) {
          db.prepare(`UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?`).run(now, part.id);
          db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE part_id = ? AND status = 'queued'`).run(part.id);

          const openCount = db.prepare(`
            SELECT COUNT(*) AS count FROM parts WHERE project_id = ? AND status = 'open'
          `).get(part.project_id).count;
          if (openCount === 0) {
            db.prepare(`UPDATE projects SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, part.project_id);
          }
        }
      } else {
        // Upload-stalled case: no finished/printing/recently-failed job, but there may be
        // a stalled 'uploading' job. Operator is confirming the print is actually running —
        // change the job to 'printing' so it resolves naturally when the printer finishes.
        const uploadingJob = db.prepare(
          "SELECT * FROM jobs WHERE printer_id = ? AND status = 'uploading' ORDER BY created_at DESC LIMIT 1"
        ).get(printer.id);
        if (uploadingJob) {
          db.prepare("UPDATE jobs SET status = 'printing', started_at = ? WHERE id = ?")
            .run(now, uploadingJob.id);
        }
      }
    }

    db.prepare('UPDATE printers SET is_held = 0 WHERE id = ?').run(printer.id);
    const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
    scheduler.scheduleForPrinter(updated);
    res.json(updated);
  });

  return app;
}

// ── Schema + seed helpers ─────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE, ip TEXT NOT NULL,
      model TEXT NOT NULL, type TEXT DEFAULT 'bambu',
      status TEXT DEFAULT 'FINISHED',
      is_held INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, ams_slot INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER NOT NULL, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

function seedPrinter(db, overrides = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, model, status, is_held, is_active, created_at)
    VALUES (?, '10.0.0.1', 'mk4s', 'FINISHED', 1, 1, ?)
  `).run(overrides.name ?? `P_${now}`, now).lastInsertRowid;
}

function seedProject(db) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, priority, created_at, updated_at) VALUES ('Proj', 'active', 0, ?, ?)`
  ).run(now, now).lastInsertRowid;
}

function seedPart(db, projectId, { targetQty = 10, completedQty = 0, status = 'open' } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
     VALUES (?, 'Part A', ?, ?, ?, 0, ?, ?)`
  ).run(projectId, targetQty, completedQty, status, now, now).lastInsertRowid;
}

function seedGcode(db, partId) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
     VALUES (?, 'mk4s', 'test.bgcode', 'test.bgcode', 4, ?)`
  ).run(partId, now).lastInsertRowid;
}

function seedJob(db, printerId, partId, gcodeId, jobStatus = 'finished', { partsPerPlate = 4, startedAt, finishedAt } = {}) {
  const now = Date.now();
  // Mirror production: _handlePrinterUnavailable stamps finished_at when it
  // marks a job failed. Recovery tests depend on this so the session-gating
  // check (finished_at > scheduler.startedAt) sees a non-null value.
  const defaultFinishedAt = (jobStatus === 'finished' || jobStatus === 'failed') ? now : null;
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    printerId, partId, gcodeId, partsPerPlate, jobStatus,
    startedAt ?? now - 3600_000,
    finishedAt ?? defaultFinishedAt,
    now - 3600_000,
  ).lastInsertRowid;
}

// ── 404 ───────────────────────────────────────────────────────────────────────

describe('POST /api/printers/:id/set-ready — 404', () => {
  test('returns 404 for unknown printer', async () => {
    const app = makeApp(makeDb());
    const res = await request(app).post('/api/printers/99999/set-ready').send({});
    expect(res.status).toBe(404);
  });
});

// ── Case 1: Normal finish ('finished' job) ────────────────────────────────────

describe('set-ready — normal finish (job already finished)', () => {
  test('releases the hold and returns 200', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'finished');

    const res = await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.is_held).toBe(0);
  });

  test('does not change completed_qty when confirmed_qty matches parts_per_plate', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'finished', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({ confirmed_qty: 4 }); // same as parts_per_plate — no delta

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4); // unchanged
  });

  test('applies negative confirmed_qty delta (operator reports fewer good parts)', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'finished', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({ confirmed_qty: 3 }); // one part was bad

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(3); // 4 + (3 - 4) = 3
  });

  test('calls scheduleForPrinter after releasing hold', async () => {
    const db        = makeDb();
    const scheduler = { scheduleForPrinter: jest.fn() };
    const printerId = seedPrinter(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'finished');

    await request(makeApp(db, scheduler))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    expect(scheduler.scheduleForPrinter).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduleForPrinter.mock.calls[0][0].is_held).toBe(0);
  });
});

// ── Case 2: Missed finish ('printing' job — server was down) ──────────────────

describe('set-ready — missed finish (printing job)', () => {
  test('credits completed_qty for the printing job', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_miss_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4);
  });

  test('marks the printing job as finished', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_missj_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'printing');

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('finished');
  });

  test('respects confirmed_qty when provided for a missed finish', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_missq_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({ confirmed_qty: 3 }); // operator says only 3 were good

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(3);
  });
});

// ── Case 3: MQTT recovery ('failed' job — transient MQTT disconnect) ──────────
//
// The Bambu MQTT 'reconnect' event causes conn.connected = false, so the next
// poll returns OFFLINE and _handlePrinterUnavailable marks the job 'failed'.
// The printer kept printing. When the operator presses Set Ready, the count
// must be credited as if it were a missed finish.

describe('set-ready — MQTT recovery (failed job, no printing or finished job)', () => {
  test('credits completed_qty for the recovered failed job', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_mqtt_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'failed', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4);
  });

  test('marks the recovered failed job as finished', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_mqttj_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'failed');

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('finished');
  });

  test('releases the hold after recovering a failed job', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_mqtth_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'failed');

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(0);
  });

  test('respects confirmed_qty when provided for an MQTT-recovered job', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_mqttq_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'failed', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({ confirmed_qty: 2 });

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(2);
  });

  test('closes the part when recovery brings completed_qty to target', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_mqttc_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'failed', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const part = db.prepare('SELECT status FROM parts WHERE id = ?').get(partId);
    expect(part.status).toBe('closed');
  });

  test('marks the project completed when recovery closes the last open part', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_mqttp_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'failed', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('completed');
  });

  test('does not credit a failed job finished before the session started', async () => {
    // Repro of the Bambu-restart phantom-credit bug at the set-ready entry point:
    // a stale failed job from a prior server run must not be credited.
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_mqtto_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);

    const sessionStart = Date.now();
    seedJob(db, printerId, partId, gcodeId, 'failed', {
      finishedAt: sessionStart - 60_000, // marked failed 1 min before the session
    });

    const scheduler = { scheduleForPrinter: jest.fn(), startedAt: sessionStart };
    await request(makeApp(db, scheduler))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(0); // stale job not credited
  });
});

// ── Case 4: Upload stalled — job is 'uploading', operator confirms it's running ──
//
// When all upload retries are exhausted and checkIfPrinting returns false, the
// scheduler leaves the job as 'uploading' and holds the printer. The operator
// checks the machine and presses Job Running. Set-ready changes the job to
// 'printing' without crediting any qty — the print resolves normally at finish.

describe('set-ready — upload stalled (uploading job, operator confirms running)', () => {
  test('changes uploading job to printing', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_upst_${Date.now()}`, status: 'IDLE' });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'uploading');

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('printing');
  });

  test('does not credit completed_qty for an uploading job', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_upstq_${Date.now()}`, status: 'IDLE' });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'uploading', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(0); // print hasn't finished — no credit yet
  });

  test('releases the hold', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_upsth_${Date.now()}`, status: 'IDLE' });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'uploading');

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(0);
  });

  test('calls scheduleForPrinter after confirming upload-stalled job', async () => {
    const db        = makeDb();
    const scheduler = { scheduleForPrinter: jest.fn(), startedAt: 0 };
    const printerId = seedPrinter(db, { name: `P_upsts_${Date.now()}`, status: 'IDLE' });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    seedJob(db, printerId, partId, gcodeId, 'uploading');

    await request(makeApp(db, scheduler))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    expect(scheduler.scheduleForPrinter).toHaveBeenCalledTimes(1);
  });

  test('ignores uploading job when a printing job also exists', async () => {
    // A printing job takes priority — the uploading job should not change status
    const db         = makeDb();
    const printerId  = seedPrinter(db, { name: `P_upst2_${Date.now()}`, status: 'IDLE' });
    const projectId  = seedProject(db);
    const partId     = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId    = seedGcode(db, partId);
    const printingId = seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });
    const uploadingId = seedJob(db, printerId, partId, gcodeId, 'uploading', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    // Printing job was handled (credited and marked finished)
    const printingJob = db.prepare('SELECT status FROM jobs WHERE id = ?').get(printingId);
    expect(printingJob.status).toBe('finished');
    // Uploading job must be left untouched
    const uploadingJob = db.prepare('SELECT status FROM jobs WHERE id = ?').get(uploadingId);
    expect(uploadingJob.status).toBe('uploading');
  });
});

// ── Case 5: Offline recovery — printing job must beat old finished job ────────
//
// Regression test for: printer goes OFFLINE with a printing job (job2), while an
// older finished job (job1 from a prior cycle) still sits in the DB. Set-ready was
// finding job1 first, taking the "already credited" normal path, and releasing the
// hold without crediting job2. _dispatchToPrinter then found the stale printing
// job2 and auto-failed it — causing the operator's green click to produce a failure.

describe('set-ready — offline recovery (printing job beats old finished job)', () => {
  test('credits the printing job when an older finished job also exists', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_offr_${Date.now()}`, status: 'IDLE' });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 }); // job1 already credited
    const gcodeId   = seedGcode(db, partId);

    // job1: an older finished job from a prior cycle (already credited)
    seedJob(db, printerId, partId, gcodeId, 'finished', {
      partsPerPlate: 4,
      finishedAt: Date.now() - 3600_000,
    });
    // job2: the current job that was printing when the printer went OFFLINE
    const job2Id = seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const job2 = db.prepare('SELECT status FROM jobs WHERE id = ?').get(job2Id);
    expect(job2.status).toBe('finished'); // must be credited, not left as printing/failed
  });

  test('increments completed_qty for the printing job, not the old finished job', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_offrc_${Date.now()}`, status: 'IDLE' });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 }); // job1 already credited
    const gcodeId   = seedGcode(db, partId);

    seedJob(db, printerId, partId, gcodeId, 'finished', {
      partsPerPlate: 4,
      finishedAt: Date.now() - 3600_000,
    });
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(8); // 4 (from job1) + 4 (from job2) = 8
  });

  test('releases the hold after crediting the printing job', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_offrh_${Date.now()}`, status: 'IDLE' });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 });
    const gcodeId   = seedGcode(db, partId);

    seedJob(db, printerId, partId, gcodeId, 'finished', {
      partsPerPlate: 4,
      finishedAt: Date.now() - 3600_000,
    });
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({});

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(0);
  });
});

// ── 6. Stopped printer (operator stopped on printer screen) ───────────────────
// The stopped job was marked 'cancelled' by _handlePrinterStopped. When it is
// newer than the last finished job, set-ready must resolve IT — not misapply
// confirmed_qty as a delta against the older finished job's part.

describe('set-ready — stopped printer (cancelled job newer than old finished job)', () => {
  function seedStoppedScenario(db) {
    const printerId = seedPrinter(db, { name: `P_stop_${Date.now()}_${Math.random()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 }); // credited by the old finished job
    const gcodeId   = seedGcode(db, partId);

    seedJob(db, printerId, partId, gcodeId, 'finished', {
      partsPerPlate: 4,
      finishedAt: Date.now() - 7200_000,
    });
    const cancelledJobId = seedJob(db, printerId, partId, gcodeId, 'cancelled', {
      partsPerPlate: 4,
      finishedAt: Date.now() - 60_000,
    });
    return { printerId, partId, cancelledJobId };
  }

  test('confirmed_qty 0 credits nothing and leaves the old finished job untouched', async () => {
    const db = makeDb();
    const { printerId, partId } = seedStoppedScenario(db);

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({ confirmed_qty: 0 });

    // Old code applied delta (0 - 4) against the finished job → would read 0 here.
    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4);
  });

  test('resolves the cancelled job and credits the confirmed qty', async () => {
    const db = makeDb();
    const { printerId, partId, cancelledJobId } = seedStoppedScenario(db);

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({ confirmed_qty: 2 });

    const job  = db.prepare('SELECT status FROM jobs WHERE id = ?').get(cancelledJobId);
    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(job.status).toBe('finished');
    expect(part.completed_qty).toBe(6); // 4 from old job + 2 confirmed good
  });

  test('releases the hold so the next job dispatches', async () => {
    const db = makeDb();
    const { printerId } = seedStoppedScenario(db);
    const scheduler = { scheduleForPrinter: jest.fn(), startedAt: 0 };

    await request(makeApp(db, scheduler))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({ confirmed_qty: 0 });

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(0);
    expect(scheduler.scheduleForPrinter).toHaveBeenCalled();
  });

  test('an older cancelled job does not shadow a newer finished job', async () => {
    const db        = makeDb();
    const printerId = seedPrinter(db, { name: `P_stopold_${Date.now()}` });
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 4 });
    const gcodeId   = seedGcode(db, partId);

    seedJob(db, printerId, partId, gcodeId, 'cancelled', {
      partsPerPlate: 4,
      finishedAt: Date.now() - 7200_000, // stopped print from a prior cycle
    });
    seedJob(db, printerId, partId, gcodeId, 'finished', {
      partsPerPlate: 4,
      finishedAt: Date.now() - 60_000, // normal finish afterwards
    });

    await request(makeApp(db))
      .post(`/api/printers/${printerId}/set-ready`)
      .send({ confirmed_qty: 3 });

    // Normal delta path against the finished job: 4 + (3 - 4) = 3
    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(3);
  });
});
