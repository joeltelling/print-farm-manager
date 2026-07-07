// Operator notification store for recoverable server alerts (held printer with a
// missing G-code, stale-job auto-cancel, upload failed after retries).
//
// Backed by the `notifications` table so alerts survive a crash/restart — a held
// printer's *reason* is no longer lost when the process dies. Call init(db) once
// at startup. Until then (or in unit tests that don't wire a DB) it falls back to
// an in-memory list so add/list/dismiss keep working.

let _db = null;
let _nextId = 1;
const _mem = [];

function init(db) {
  _db = db;
}

function add(message) {
  const timestamp = Date.now();
  console.warn(`[notifications] ${message}`);
  if (_db) {
    const info = _db
      .prepare('INSERT INTO notifications (message, created_at) VALUES (?, ?)')
      .run(message, timestamp);
    return { id: Number(info.lastInsertRowid), message, timestamp };
  }
  const note = { id: _nextId++, message, timestamp };
  _mem.push(note);
  return note;
}

function list() {
  if (_db) {
    // `timestamp` alias preserves the API response shape (see docs/api.md).
    return _db
      .prepare('SELECT id, message, created_at AS timestamp FROM notifications ORDER BY created_at DESC, id DESC')
      .all();
  }
  return [..._mem].reverse(); // newest first
}

function dismiss(id) {
  if (_db) {
    return _db.prepare('DELETE FROM notifications WHERE id = ?').run(id).changes > 0;
  }
  const idx = _mem.findIndex(n => n.id === id);
  if (idx === -1) return false;
  _mem.splice(idx, 1);
  return true;
}

module.exports = { init, add, list, dismiss };
