#!/usr/bin/env node
/**
 * Demo seed script — populates a fresh install with a realistic mixed-fleet scenario.
 *
 * WARNING: Clears ALL data in the dedicated seed-data.db database.
 *
 * Usage:
 *   node server/seed-demo.js --confirm
 *
 * Then start the server in demo mode so the poller doesn't overwrite seeded statuses:
 *   DEMO_MODE=true npm start
 */

if (!process.argv.includes('--confirm')) {
  console.error(`
  CoMa: DEMO SEED

  This script DELETES all data in seed-data.db and replaces it with demo data.
  organic-data.db is never opened or modified.

  To proceed:
    node server/seed-demo.js --confirm
`);
  process.exit(1);
}

const path = require('path');
const fs = require('fs');
const { getDatabasePath } = require('./database-path');

const gcodeDir = path.join(__dirname, 'gcode');
if (!fs.existsSync(gcodeDir)) fs.mkdirSync(gcodeDir, { recursive: true });

process.env.PFM_DATASET = 'seed';
const databasePath = getDatabasePath({ PFM_DATASET: 'seed' });
const db = require('./db');
db.pragma('foreign_keys = OFF');

// Clear all seed data in FK-safe order. The organic database is never opened.
for (const t of [
  'jobs', 'printer_events', 'gcodes', 'parts', 'projects', 'printers',
  'printer_models', 'filament_colors', 'filament_types', 'printer_groups', 'settings',
]) {
  db.prepare(`DELETE FROM ${t}`).run();
}
// Reset autoincrement counters so IDs start from 1
try {
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN
    ('printers','projects','parts','gcodes','jobs','printer_events','filament_types','filament_colors')`);
} catch (_) {}

db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('farm_name', 'CoMa Lab')").run();
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('camera_mode', 'snapshot')").run();

// ─── Time helpers ────────────────────────────────────────────────────────────
const now = Date.now();
const hr  = 3600_000;
const day = 86_400_000;

// ─── Filament library (Materials tab) ─────────────────────────────────────────
const insertFilamentType = db.prepare('INSERT INTO filament_types (name) VALUES (?)');
const plaTypeId  = Number(insertFilamentType.run('PLA').lastInsertRowid);
const petgTypeId = Number(insertFilamentType.run('PETG').lastInsertRowid);
const insertFilamentColor = db.prepare(
  'INSERT INTO filament_colors (type_id, name, hex_color) VALUES (?, ?, ?)'
);
insertFilamentColor.run(plaTypeId,  'Black',      '#1a1a1a');
insertFilamentColor.run(plaTypeId,  'Galaxy Red', '#8b0000');
insertFilamentColor.run(petgTypeId, 'Grey',       '#6b7280');

// ─── Printer groups ───────────────────────────────────────────────────────────
const insertGroup = db.prepare(
  'INSERT OR IGNORE INTO printer_groups (name, created_at) VALUES (?, ?)'
);
for (const name of ['MK4S Farm', 'Elegoo Farm', 'Bambu Farm', 'Sim Lab']) {
  insertGroup.run(name, now - 30 * day);
}

// ─── Printer models ───────────────────────────────────────────────────────────
const insertModel = db.prepare(
  'INSERT OR REPLACE INTO printer_models (model_id, label, connector) VALUES (?, ?, ?)'
);
insertModel.run('mk4s',            'MK4S',            'prusa');
insertModel.run('centauri-carbon', 'Centauri Carbon', 'elegoo-centauri');
insertModel.run('x1c',             'X1 Carbon',       'bambu');
insertModel.run('voron-24',        'Voron 2.4',       'klipper');

// ─── Printers ─────────────────────────────────────────────────────────────────
// Columns: name, ip, api_key, group_name, type, model, status, is_held, is_active,
//          created_at, job_name, job_progress, job_time_remaining, serial_number
const insertPrinter = db.prepare(`
  INSERT INTO printers
    (name, ip, api_key, group_name, type, model, status, is_held, is_active,
     created_at, job_name, job_progress, job_time_remaining, serial_number)
  VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)
`);

const PRINTERS = [
  // Prusa MK4S farm: mix of states to demonstrate all card types
  ['MK4S_01', '192.168.1.101', 'aK3jR7xQ2pLm', 'MK4S Farm', 'prusa', 'mk4s',
    'PRINTING', 0, now - 30*day, 'benchy_4up_mk4s.bgcode',     0.35, 7200,  ''],
  ['MK4S_02', '192.168.1.102', 'bN8wT4yV6cDk', 'MK4S Farm', 'prusa', 'mk4s',
    'PRINTING', 0, now - 30*day, 'benchy_4up_mk4s.bgcode',     0.72, 2700,  ''],
  ['MK4S_03', '192.168.1.103', 'cP5uR9zX1mFj', 'MK4S Farm', 'prusa', 'mk4s',
    'PRINTING', 0, now - 30*day, 'gridfinity_2x4_mk4s.bgcode', 0.91,  540,  ''],
  ['MK4S_04', '192.168.1.104', 'dQ2sL6wY3nGh', 'MK4S Farm', 'prusa', 'mk4s',
    'FINISHED', 1, now - 30*day, null, null, null, ''],   // waiting for operator confirmation
  ['MK4S_05', '192.168.1.105', 'eR7tM4vA8pJi', 'MK4S Farm', 'prusa', 'mk4s',
    'IDLE',    0, now - 30*day, null, null, null, ''],
  ['MK4S_06', '192.168.1.106', 'fS9nK2bC5qLe', 'MK4S Farm', 'prusa', 'mk4s',
    'IDLE',    0, now - 30*day, null, null, null, ''],
  ['MK4S_07', '192.168.1.107', 'gT3oJ7dD1rMf', 'MK4S Farm', 'prusa', 'mk4s',
    'ERROR',   1, now - 30*day, null, null, null, ''],    // filament runout, held
  ['MK4S_08', '192.168.1.108', 'hU6pI5eE4sNg', 'MK4S Farm', 'prusa', 'mk4s',
    'OFFLINE', 1, now - 30*day, null, null, null, ''],   // network unreachable
  // Elegoo Centauri Carbon
  ['Centauri_01', '192.168.1.150', '', 'Elegoo Farm', 'elegoo-centauri', 'centauri-carbon',
    'PRINTING', 0, now - 14*day, 'benchy_4up_centauri.cws', 0.55, 3600, ''],
  ['Centauri_02', '192.168.1.151', '', 'Elegoo Farm', 'elegoo-centauri', 'centauri-carbon',
    'IDLE',    0, now - 14*day, null, null, null, ''],
  // Bambu X1 Carbon
  ['X1C_01', '192.168.1.200', 'BBLP-DEMO01', 'Bambu Farm', 'bambu', 'x1c',
    'PRINTING', 0, now - 7*day, 'gridfinity_2x4_x1c.3mf', 0.88, 1200, 'DEMO00000001'],
  // Klipper / Virtual Klipper Printer (Moonraker :7125, webcam :8110)
  // DEMO_MODE still polls loopback hosts so this row stays live for camera testing.
  ['Virtual Klipper', '127.0.0.1', '', 'Sim Lab', 'klipper', 'voron-24',
    'IDLE',    0, now - 1*day, null, null, null, ''],
];

const printerIds = {};
for (const p of PRINTERS) {
  const r = insertPrinter.run(...p);
  printerIds[p[0]] = Number(r.lastInsertRowid);
}

// ─── Projects ─────────────────────────────────────────────────────────────────
const insertProject = db.prepare(`
  INSERT INTO projects (name, description, status, priority, created_at, updated_at)
  VALUES (?,?,?,?,?,?)
`);

const benchyProjId     = Number(insertProject.run(
  'Benchy Fleet',
  'Print 100 standard benchies in PLA as a calibration baseline across all printers.',
  'active', 10, now - 14*day, now - 2*hr
).lastInsertRowid);

const gridfinityProjId = Number(insertProject.run(
  'Gridfinity Organizer Set',
  'Full gridfinity bin set for 8 drawer units in the workshop. Mixed 1x2, 2x4, and 4x4 sizes.',
  'active', 20, now - 30*day, now - hr
).lastInsertRowid);

const cableProjId      = Number(insertProject.run(
  'Cable Management Clips',
  'Desk cable routing clips. On hold until PETG filament order arrives.',
  'draft', 5, now - 3*day, now - 3*day
).lastInsertRowid);

// ─── Parts ───────────────────────────────────────────────────────────────────
const insertPart = db.prepare(`
  INSERT INTO parts
    (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?)
`);

const benchyPartId      = Number(insertPart.run(benchyProjId,     'Standard Benchy',     100,  47, 'open', 0, now - 14*day, now - hr  ).lastInsertRowid);
const miniBenchyPartId  = Number(insertPart.run(benchyProjId,     'Mini Benchy (60%)',    50,  12, 'open', 1, now - 14*day, now - 2*hr).lastInsertRowid);
const grid2x4PartId     = Number(insertPart.run(gridfinityProjId, '2x4 Gridfinity Bin',  200, 134, 'open', 0, now - 30*day, now - 30*60*1000).lastInsertRowid);
const grid4x4PartId     = Number(insertPart.run(gridfinityProjId, '4x4 Gridfinity Bin',  100,  67, 'open', 1, now - 30*day, now - hr  ).lastInsertRowid);
const grid1x2PartId     = Number(insertPart.run(gridfinityProjId, '1x2 Gridfinity Bin',  300, 300, 'done', 2, now - 30*day, now - 5*day).lastInsertRowid);
const clipPartId        = Number(insertPart.run(cableProjId,      'Clip Body',            500,   0, 'open', 0, now - 3*day, now - 3*day).lastInsertRowid);

// ─── G-code files ─────────────────────────────────────────────────────────────
const insertGcode = db.prepare(`
  INSERT INTO gcodes
    (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, created_at, ams_slot)
  VALUES (?,?,?,?,?,?,?,?)
`);

const GCODES = [
  // [filename, partId, model, partsPerPlate, estSecs, amsSlot]
  ['benchy_4up_mk4s.bgcode',        benchyPartId,     'mk4s',            4, 10800, null],
  ['benchy_4up_centauri.cws',       benchyPartId,     'centauri-carbon', 4, 10800, null],
  ['mini_benchy_4up_mk4s.bgcode',   miniBenchyPartId, 'mk4s',            4,  6000, null],
  ['gridfinity_2x4_mk4s.bgcode',    grid2x4PartId,    'mk4s',            6,  7200, null],
  ['gridfinity_2x4_x1c.3mf',       grid2x4PartId,    'x1c',             8,  5400,    0],
  ['gridfinity_4x4_mk4s.bgcode',    grid4x4PartId,    'mk4s',            2, 14400, null],
  // Present for the simulator model list; not linked to an open dispatch-eligible
  // plate so the live Virtual Klipper stays idle for camera/status testing.
  ['benchy_voron.gcode',            clipPartId,       'voron-24',        1,  9000, null],
];

const gcodeIds = {};
for (const [filename, partId, model, ppp, secs, amsSlot] of GCODES) {
  const filepath = path.join(gcodeDir, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, `; Demo placeholder: ${filename}\n`);
  }
  const r = insertGcode.run(partId, model, filename, filepath, ppp, secs, now - 14*day, amsSlot);
  gcodeIds[filename] = Number(r.lastInsertRowid);
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────
const insertJob = db.prepare(`
  INSERT INTO jobs
    (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
  VALUES (?,?,?,?,?,?,?,?)
`);

// Historical done jobs building up the completed_qty totals
const DONE_JOBS = [
  // [partId, printerName, gcodeFile, ppp, startOffset, finishOffset]
  [benchyPartId,    'MK4S_05', 'benchy_4up_mk4s.bgcode',     4, -12*day, -12*day + 3*hr],
  [benchyPartId,    'MK4S_06', 'benchy_4up_mk4s.bgcode',     4, -11*day, -11*day + 3*hr],
  [benchyPartId,    'MK4S_05', 'benchy_4up_mk4s.bgcode',     4, -10*day, -10*day + 3*hr],
  [benchyPartId,    'MK4S_06', 'benchy_4up_mk4s.bgcode',     4,  -9*day,  -9*day + 3*hr],
  [benchyPartId,    'Centauri_01', 'benchy_4up_centauri.cws',4,  -8*day,  -8*day + 3*hr],
  [miniBenchyPartId,'MK4S_05', 'mini_benchy_4up_mk4s.bgcode',4,  -7*day,  -7*day + 1.5*hr],
  [miniBenchyPartId,'MK4S_06', 'mini_benchy_4up_mk4s.bgcode',4,  -6*day,  -6*day + 1.5*hr],
  [grid2x4PartId,   'MK4S_01', 'gridfinity_2x4_mk4s.bgcode', 6,  -7*day,  -7*day + 2*hr],
  [grid2x4PartId,   'MK4S_02', 'gridfinity_2x4_mk4s.bgcode', 6,  -6*day,  -6*day + 2*hr],
  [grid2x4PartId,   'MK4S_03', 'gridfinity_2x4_mk4s.bgcode', 6,  -5*day,  -5*day + 2*hr],
  [grid4x4PartId,   'MK4S_03', 'gridfinity_4x4_mk4s.bgcode', 2,  -5*day,  -5*day + 4*hr],
  [grid4x4PartId,   'MK4S_04', 'gridfinity_4x4_mk4s.bgcode', 2,  -4*day,  -4*day + 4*hr],
  [grid2x4PartId,   'X1C_01',  'gridfinity_2x4_x1c.3mf',     8,  -4*day,  -4*day + 1.5*hr],
  [grid1x2PartId,   'MK4S_04', 'gridfinity_2x4_mk4s.bgcode', 6,  -3*day,  -3*day + 2*hr],
  [grid1x2PartId,   'MK4S_05', 'gridfinity_2x4_mk4s.bgcode', 6,  -2*day,  -2*day + 2*hr],
  [grid1x2PartId,   'MK4S_06', 'gridfinity_2x4_mk4s.bgcode', 6,  -1*day,  -1*day + 2*hr],
];

for (const [partId, pName, gFile, ppp, startOff, finOff] of DONE_JOBS) {
  insertJob.run(partId, printerIds[pName], gcodeIds[gFile], ppp,
    'done', now + startOff, now + finOff, now + startOff - 5000);
}

// Active printing jobs — one per currently-PRINTING printer
const PRINTING_JOBS = [
  [benchyPartId,   'MK4S_01',     'benchy_4up_mk4s.bgcode',     4, -3*hr],
  [benchyPartId,   'MK4S_02',     'benchy_4up_mk4s.bgcode',     4, -2.5*hr],
  [grid2x4PartId,  'MK4S_03',     'gridfinity_2x4_mk4s.bgcode', 6, -hr],
  [benchyPartId,   'Centauri_01', 'benchy_4up_centauri.cws',    4, -2*hr],
  [grid2x4PartId,  'X1C_01',      'gridfinity_2x4_x1c.3mf',    8, -1.5*hr],
];

for (const [partId, pName, gFile, ppp, startOff] of PRINTING_JOBS) {
  insertJob.run(partId, printerIds[pName], gcodeIds[gFile], ppp,
    'printing', now + startOff, null, now + startOff - 5000);
}

// MK4S_04 — print just finished, awaiting operator confirmation (job still 'printing')
insertJob.run(benchyPartId, printerIds['MK4S_04'], gcodeIds['benchy_4up_mk4s.bgcode'], 4,
  'printing', now - 3*hr, null, now - 3*hr - 5000);

// MK4S_07 — failed job that put it into ERROR state
insertJob.run(benchyPartId, printerIds['MK4S_07'], gcodeIds['benchy_4up_mk4s.bgcode'], 4,
  'failed', now - 4*hr, null, now - 4*hr - 5000);

// ─── Printer events ───────────────────────────────────────────────────────────
const insertEvent = db.prepare(
  'INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?,?,?,?)'
);

// MK4S_01: normal job history
insertEvent.run(printerIds['MK4S_01'], 'job_finished', '4 parts credited: print confirmed OK', now - 12*day + 3*hr);
insertEvent.run(printerIds['MK4S_01'], 'job_finished', '4 parts credited: print confirmed OK', now - 9*day  + 3*hr);
insertEvent.run(printerIds['MK4S_01'], 'job_start', 'benchy_4up_mk4s.bgcode', now - 3*hr);

// MK4S_04: finished, awaiting confirmation
insertEvent.run(printerIds['MK4S_04'], 'job_finished', '2 parts credited: print confirmed OK', now - 4*day + 4*hr);
insertEvent.run(printerIds['MK4S_04'], 'job_start', 'benchy_4up_mk4s.bgcode', now - 3*hr);

// MK4S_07: error state
insertEvent.run(printerIds['MK4S_07'], 'job_start', 'benchy_4up_mk4s.bgcode', now - 4*hr);
insertEvent.run(printerIds['MK4S_07'], 'job_failed','Filament runout detected mid-print',   now - 2*hr);
insertEvent.run(printerIds['MK4S_07'], 'error', 'Hardware ERROR: filament runout', now - 2*hr + 1000);

// MK4S_08: went offline
insertEvent.run(printerIds['MK4S_08'], 'offline_with_job', 'PRINTING to OFFLINE during gridfinity plate', now - 2*day);

// Centauri_01: running normally
insertEvent.run(printerIds['Centauri_01'], 'job_finished', '4 parts credited', now - 8*day + 3*hr);
insertEvent.run(printerIds['Centauri_01'], 'job_start', 'benchy_4up_centauri.cws', now - 2*hr);

// X1C_01: Bambu with AMS
insertEvent.run(printerIds['X1C_01'], 'job_finished', '8 parts credited: AMS slot 1 (grey PETG)', now - 4*day + 1.5*hr);
insertEvent.run(printerIds['X1C_01'], 'job_start', 'gridfinity_2x4_x1c.3mf: AMS slot 1', now - 1.5*hr);

// Virtual Klipper: simulator history for the incident log
insertEvent.run(printerIds['Virtual Klipper'], 'note', 'Connected to local Virtual Klipper Printer (Moonraker :7125, webcam :8110)', now - 6*hr);
insertEvent.run(printerIds['Virtual Klipper'], 'job_finished', 'Calibration cube OK (simulator)', now - 5*hr);
insertEvent.run(printerIds['Virtual Klipper'], 'info_changed', 'IP set to 127.0.0.1 for Sim Lab', now - 4*hr);

db.pragma('foreign_keys = ON');

const totalJobs = DONE_JOBS.length + PRINTING_JOBS.length + 2;
db.close();
console.log(`
  Seed data written to ${databasePath}

  Printers : ${PRINTERS.length} (${PRINTERS.filter(p => p[6] === 'PRINTING').length} printing, 1 finished, idle mix, 1 error, 1 offline)
  Live sim : Virtual Klipper at 127.0.0.1 (Moonraker :7125 / webcam :8110)
  Projects : 3 (2 active, 1 draft)
  Parts    : ${[benchyPartId, miniBenchyPartId, grid2x4PartId, grid4x4PartId, grid1x2PartId, clipPartId].length}
  G-codes  : ${GCODES.length}
  Jobs     : ${totalJobs} (${DONE_JOBS.length} done, ${PRINTING_JOBS.length + 2} active/failed)
  Settings : farm_name=CoMa Lab, camera_mode=snapshot

  Start with seed data + simulator (DEMO_MODE keeps fictional statuses, still polls 127.0.0.1):
    ./start.sh --seed-data --with-simulator

  Open http://localhost:5173 and open Virtual Klipper for the camera.
`);
