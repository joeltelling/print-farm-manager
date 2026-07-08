// Hourly SQLite backup using better-sqlite3's online backup API.
// Writes to server/data/backups/farm-YYYY-MM-DD-HH.db
// Keeps the most recent KEEP_COUNT files; older ones are deleted automatically.

const path = require('path');
const fs   = require('fs');

const BACKUP_DIR  = path.join(__dirname, 'data', 'backups');
const KEEP_COUNT  = 24;           // 24 hourly snapshots = 1 day of point-in-time recovery
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
}

let _active = null; // promise of the in-flight backup, or null when idle

async function runBackup(db) {
  // Never run two backups at once: a slow run overlapping the next hourly tick
  // would overwrite `_active`, so whenIdle() could see it cleared (newer run done)
  // while an older `db.backup()` is still copying — the exact mid-copy-close race
  // this guards against. It also avoids two concurrent db.backup() on one
  // connection. Backups take seconds, so skipping a tick here is harmless.
  if (_active) {
    console.warn('[backup] Previous backup still running — skipping this run');
    return;
  }
  // Track the in-flight run so graceful shutdown can wait for it before closing
  // the DB. `_doBackup` swallows its own errors, so `_active` never rejects.
  const p = _doBackup(db);
  _active = p;
  try { await p; } finally { if (_active === p) _active = null; }
}

async function _doBackup(db) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dest = path.join(BACKUP_DIR, `farm-${timestamp()}.db`);
  try {
    await db.backup(dest);
    console.log(`[backup] Saved ${path.basename(dest)}`);
    pruneOldBackups();
  } catch (err) {
    console.error('[backup] Failed:', err.message);
  }
}

function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('farm-') && f.endsWith('.db'))
    .sort()   // lexicographic sort on YYYY-MM-DD-HH puts oldest first
    .reverse(); // newest first

  for (const f of files.slice(KEEP_COUNT)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log(`[backup] Pruned ${f}`);
    } catch (err) {
      console.error(`[backup] Could not prune ${f}:`, err.message);
    }
  }
}

let _timer = null;

function start(db) {
  // Run immediately on startup, then every hour
  runBackup(db);
  _timer = setInterval(() => runBackup(db), INTERVAL_MS);
}

// Stop the hourly timer — called on graceful shutdown before db.close() so a
// scheduled backup can't start against a connection that's about to close.
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

// Resolves once no backup is in flight (immediately if already idle). Graceful
// shutdown awaits this after stop() and before db.close(), so it never closes the
// connection or exits mid-`db.backup()`.
async function whenIdle() {
  while (_active) {
    try { await _active; } catch (_) { /* _doBackup never rejects; belt-and-braces */ }
  }
}

module.exports = { start, runBackup, stop, whenIdle };
