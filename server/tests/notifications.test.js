// Verifies the DB-backed notification store: alerts persist to the `notifications`
// table so a crash/restart doesn't leave held printers with no explanation, and the
// API response shape ({ id, message, timestamp }) is preserved. Also covers the
// in-memory fallback used before init(db) / in tests that don't wire a DB.

const Database = require('better-sqlite3');
const os = require('os');
const path = require('path');
const fs = require('fs');

const notifications = require('../notifications');

const SCHEMA = `CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`;

function memDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function tmpFile() {
  return path.join(os.tmpdir(), `pfm-notif-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
}

describe('notifications (DB-backed)', () => {
  let db;
  beforeEach(() => { db = memDb(); notifications.init(db); });
  afterEach(() => { notifications.init(null); db.close(); });

  test('add persists a row and returns { id, message, timestamp }', () => {
    const note = notifications.add('held: missing gcode');
    expect(note).toMatchObject({ message: 'held: missing gcode' });
    expect(typeof note.id).toBe('number');
    expect(typeof note.timestamp).toBe('number');
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(note.id);
    expect(row.message).toBe('held: missing gcode');
  });

  test('list returns newest first with a timestamp field (API shape)', () => {
    notifications.add('alert one');
    notifications.add('alert two');
    const list = notifications.list();
    expect(list.map(n => n.message)).toEqual(['alert two', 'alert one']);
    expect(list[0]).toHaveProperty('timestamp');
    expect(list[0]).not.toHaveProperty('created_at');
  });

  test('dismiss removes a notification; unknown id returns false', () => {
    const note = notifications.add('dismiss me');
    expect(notifications.dismiss(note.id)).toBe(true);
    expect(notifications.list()).toHaveLength(0);
    expect(notifications.dismiss(99999)).toBe(false);
  });
});

test('notifications survive a restart — a fresh DB connection still sees them', () => {
  const file = tmpFile();
  const db1 = new Database(file);
  db1.exec(SCHEMA);
  notifications.init(db1);
  notifications.add('printer held: re-upload MK4S gcode');
  db1.close(); // process "dies"

  // New process boots against the same DB file.
  const db2 = new Database(file);
  notifications.init(db2);
  expect(notifications.list().map(n => n.message)).toContain('printer held: re-upload MK4S gcode');
  db2.close();
  notifications.init(null);
  fs.unlinkSync(file);
});

test('falls back to in-memory when no DB is initialized', () => {
  notifications.init(null);
  const note = notifications.add('mem only');
  expect(note.message).toBe('mem only');
  expect(notifications.list()[0].message).toBe('mem only');
  expect(notifications.dismiss(note.id)).toBe(true);
  expect(notifications.list()).toHaveLength(0);
});
