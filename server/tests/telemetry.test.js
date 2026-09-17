const Database = require('better-sqlite3');
const {
  SAMPLE_GAP_CAP_MS,
  recordStatusTransition,
  accumulateJobSample,
  sealJobTelemetry,
  computeTelemetryQuality,
  getJobTelemetry,
  getPrinterUtilization,
} = require('../telemetry');

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY, name TEXT, status TEXT, job_progress REAL
    );
    CREATE TABLE parts (id INTEGER PRIMARY KEY, name TEXT, erp_sku TEXT);
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, material_grams REAL);
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER DEFAULT 1,
      status TEXT DEFAULT 'printing',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER,
      printing_seconds REAL NOT NULL DEFAULT 0,
      paused_seconds REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_sample_at INTEGER,
      material_grams_actual REAL,
      energy_kwh REAL,
      telemetry_quality TEXT NOT NULL DEFAULT 'none'
    );
    CREATE TABLE printer_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      job_id INTEGER,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER
    );
    CREATE TABLE machine (
      id INTEGER PRIMARY KEY, machine TEXT, printer_id INTEGER, power_kw REAL DEFAULT 0
    );
  `);
  db.prepare("INSERT INTO printers (id, name, status) VALUES (1, 'P1', 'IDLE')").run();
  db.prepare("INSERT INTO parts (id, name, erp_sku) VALUES (1, 'Bracket', 'COMP-1')").run();
  db.prepare('INSERT INTO gcodes (id, material_grams) VALUES (1, 100)').run();
  db.prepare("INSERT INTO machine (id, machine, printer_id, power_kw) VALUES (1, 'P1', 1, 0.35)").run();
  return db;
}

describe('telemetry', () => {
  let db;
  beforeEach(() => { db = setup(); });
  afterEach(() => db.close());

  test('status transition closes previous open row', () => {
    const t0 = 1_000_000;
    recordStatusTransition(db, { printerId: 1, previousStatus: 'IDLE', newStatus: 'PRINTING', now: t0 });
    recordStatusTransition(db, { printerId: 1, previousStatus: 'PRINTING', newStatus: 'FINISHED', now: t0 + 5000 });
    const rows = db.prepare('SELECT * FROM printer_status_history ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('PRINTING');
    expect(rows[0].ended_at).toBe(t0 + 5000);
    expect(rows[0].duration_ms).toBe(5000);
    expect(rows[1].status).toBe('FINISHED');
    expect(rows[1].ended_at).toBeNull();
  });

  test('sample gap is capped so restart cannot credit phantom hours', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO jobs (id, part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at, last_sample_at)
      VALUES (1, 1, 1, 1, 1, 'printing', ?, ?, ?)
    `).run(now - 3_600_000, now - 3_600_000, now - 3_600_000);

    accumulateJobSample(db, { printerId: 1, status: 'PRINTING', now });
    const job = db.prepare('SELECT * FROM jobs WHERE id = 1').get();
    expect(job.printing_seconds).toBeCloseTo(SAMPLE_GAP_CAP_MS / 1000, 5);
    expect(job.sample_count).toBe(1);
  });

  test('sealJobTelemetry sets energy and measured quality with enough samples', () => {
    const start = Date.now() - 600_000;
    const end = Date.now();
    db.prepare(`
      INSERT INTO jobs (
        id, part_id, printer_id, gcode_id, parts_per_plate, status,
        started_at, finished_at, created_at, printing_seconds, sample_count
      ) VALUES (1, 1, 1, 1, 1, 'finished', ?, ?, ?, 540, 40)
    `).run(start, end, start);

    const sealed = sealJobTelemetry(db, 1);
    expect(sealed.telemetry_quality).toBe('measured');
    expect(sealed.energy_kwh).toBeCloseTo((540 / 3600) * 0.35, 5);
    expect(sealed.material_grams_actual).toBe(100);
  });

  test('computeTelemetryQuality returns none without samples', () => {
    expect(computeTelemetryQuality({ printing_seconds: 0, sample_count: 0 })).toBe('none');
  });

  test('getJobTelemetry 404 shape via null', () => {
    expect(getJobTelemetry(db, 999)).toBeNull();
  });

  test('getPrinterUtilization aggregates history', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO printer_status_history (printer_id, status, started_at, ended_at, duration_ms)
      VALUES (1, 'PRINTING', ?, ?, 10000), (1, 'IDLE', ?, ?, 5000)
    `).run(now - 20000, now - 10000, now - 10000, now);
    const u = getPrinterUtilization(db, 1, { days: 1 });
    expect(u.printer_name).toBe('P1');
    expect(u.printing_ms).toBe(10000);
    expect(u.idle_ms).toBe(5000);
  });
});
