// Automatic SQLite snapshots using better-sqlite3's online backup API.
// Writes to server/data/backups/farm-YYYY-MM-DD-HH.db and keeps the most recent
// KEEP_COUNT files; older ones are deleted automatically.
//
// A snapshot is taken once at startup, then checked hourly but only taken when the
// database has changed since the last one. An idle farm used to write and prune an
// identical snapshot every hour, filling the console with backup lines and, worse,
// pushing the last snapshot from before the farm went quiet out of the 24 kept within
// a day. Now the kept snapshots are the last KEEP_COUNT distinct states: about a day of
// hourly history while printing, and much further back when the farm sits idle.

const path = require('path');
const fs   = require('fs');

const BACKUP_DIR  = path.join(__dirname, 'data', 'backups');
const KEEP_COUNT  = 24;             // most recent distinct snapshots to keep
const INTERVAL_MS = 60 * 60 * 1000; // how often to check for changes (1 hour)

// What the database looked like at each connection's last successful snapshot.
const lastSnapshot = new WeakMap();

// Changes since the last snapshot show up in one of two counters:
//   total_changes()      rows this connection inserted, updated or deleted since it
//                        opened. Every server write goes through the one connection
//                        from db.js, including poller status changes and print progress.
//   PRAGMA data_version  bumps when ANOTHER connection commits, such as the
//                        audit-dry-run script's --repair --apply run beside the server.
// Neither moves when nothing is written, and taking a snapshot moves neither.
function changeMarker(db) {
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const version = db.pragma('data_version', { simple: true });
  return `${changes}:${version}`;
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
}

// Takes a snapshot if the database changed since the last one (or always, with force).
// Returns { saved: <path> }, { skipped: true } when nothing changed, or { error } on
// failure. A failed snapshot does not count, so the next check tries again.
async function runBackup(db, { force = false, dir = BACKUP_DIR } = {}) {
  const marker = changeMarker(db);
  if (!force && lastSnapshot.get(db) === marker) return { skipped: true };

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `farm-${timestamp()}.db`);
  try {
    await db.backup(dest);
    // The marker read BEFORE the snapshot: anything written while it ran moves the
    // counters past it, so the next check still sees a change and snapshots again.
    lastSnapshot.set(db, marker);
    console.log(`[backup] Saved ${path.basename(dest)}`);
    pruneOldBackups(dir);
    return { saved: dest };
  } catch (err) {
    console.error('[backup] Failed:', err.message);
    return { error: err };
  }
}

function pruneOldBackups(dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('farm-') && f.endsWith('.db'))
    .sort()   // lexicographic sort on YYYY-MM-DD-HH puts oldest first
    .reverse(); // newest first

  for (const f of files.slice(KEEP_COUNT)) {
    try {
      fs.unlinkSync(path.join(dir, f));
      console.log(`[backup] Pruned ${f}`);
    } catch (err) {
      console.error(`[backup] Could not prune ${f}:`, err.message);
    }
  }
}

function start(db) {
  // Always snapshot on startup (the state this process starts from), then check hourly
  // and snapshot only when something changed. Unchanged checks log nothing.
  runBackup(db, { force: true });
  setInterval(() => runBackup(db), INTERVAL_MS);
}

module.exports = { start, runBackup, pruneOldBackups, KEEP_COUNT };
