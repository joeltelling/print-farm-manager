// Tests for the automatic snapshot schedule in server/backup.js.
//
// Real trigger (2026-10-11): with the farm idle for over a week, the server still wrote
// and pruned an identical snapshot every hour, so the console was nothing but
// "[backup] Saved" / "[backup] Pruned" lines and the 24 kept snapshots were all copies
// of the idle state. A scheduled check now snapshots only when the database changed.

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const Database = require('better-sqlite3');
const backup   = require('../backup');

let tmp;
let dbFile;
let db;
let snapDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-backup-'));
  dbFile = path.join(tmp, 'farm.db');
  snapDir = path.join(tmp, 'backups');
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO printers (name, status) VALUES ('MK4S_01', 'IDLE');
  `);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const snapshots = () => (fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : []);

describe('change-based snapshots', () => {
  test('the startup snapshot is always taken', async () => {
    const r = await backup.runBackup(db, { force: true, dir: snapDir });
    expect(r.saved).toBeTruthy();
    expect(snapshots()).toHaveLength(1);
  });

  test('an unchanged database is skipped silently', async () => {
    await backup.runBackup(db, { force: true, dir: snapDir });
    console.log.mockClear();

    db.prepare('SELECT * FROM printers').all(); // reads are not changes
    const r = await backup.runBackup(db, { dir: snapDir });

    expect(r).toEqual({ skipped: true });
    expect(console.log).not.toHaveBeenCalled();
  });

  test('stays skipped across many idle checks', async () => {
    await backup.runBackup(db, { force: true, dir: snapDir });
    for (let i = 0; i < 5; i++) {
      expect(await backup.runBackup(db, { dir: snapDir })).toEqual({ skipped: true });
    }
  });

  test('a write on the server connection triggers the next snapshot', async () => {
    await backup.runBackup(db, { force: true, dir: snapDir });
    db.prepare("UPDATE printers SET status = 'OFFLINE' WHERE id = 1").run();

    const r = await backup.runBackup(db, { dir: snapDir });
    expect(r.saved).toBeTruthy();
    // ...and only once: the check after that is idle again.
    expect(await backup.runBackup(db, { dir: snapDir })).toEqual({ skipped: true });
  });

  test('a write from another connection (e.g. audit-dry-run --repair --apply) triggers a snapshot', async () => {
    await backup.runBackup(db, { force: true, dir: snapDir });
    const other = new Database(dbFile);
    other.prepare("INSERT INTO settings (key, value) VALUES ('farm_name', 'Test')").run();
    other.close();

    const r = await backup.runBackup(db, { dir: snapDir });
    expect(r.saved).toBeTruthy();
  });

  test('a write that changes no rows does not count', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();
    await backup.runBackup(db, { force: true, dir: snapDir });
    // The startup seed in db.js: INSERT OR IGNORE on an existing key changes nothing.
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();

    expect(await backup.runBackup(db, { dir: snapDir })).toEqual({ skipped: true });
  });

  test('a failed snapshot is retried at the next check', async () => {
    await backup.runBackup(db, { force: true, dir: snapDir });
    db.prepare("UPDATE printers SET status = 'PRINTING' WHERE id = 1").run();

    const blocked = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(blocked, 'x'); // a file where the snapshot folder should be
    const failed = await backup.runBackup(db, { dir: blocked });
    expect(failed.error).toBeTruthy();

    const retried = await backup.runBackup(db, { dir: snapDir });
    expect(retried.saved).toBeTruthy();
  });

  test('a snapshot is a readable copy of the database', async () => {
    const r = await backup.runBackup(db, { force: true, dir: snapDir });
    const copy = new Database(r.saved, { readonly: true });
    expect(copy.prepare('SELECT name FROM printers').get().name).toBe('MK4S_01');
    copy.close();
  });
});

describe('pruneOldBackups', () => {
  test('keeps the newest KEEP_COUNT snapshots', () => {
    fs.mkdirSync(snapDir, { recursive: true });
    const names = [];
    for (let d = 1; d <= backup.KEEP_COUNT + 3; d++) {
      const name = `farm-2026-09-${String(d).padStart(2, '0')}-12.db`;
      fs.writeFileSync(path.join(snapDir, name), '');
      names.push(name);
    }

    backup.pruneOldBackups(snapDir);

    expect(snapshots().sort()).toEqual(names.slice(3));
  });
});
