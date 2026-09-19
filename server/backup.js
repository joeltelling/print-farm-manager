// Hourly SQLite backup using better-sqlite3's online backup API.
// Writes to server/data/backups/farm-YYYY-MM-DD-HH.db
// Keeps the most recent KEEP_COUNT files; older ones are deleted automatically.

const path = require('path');
const fs   = require('fs');

const BACKUP_DIR  = require('./paths').backupDir;
const KEEP_COUNT  = 24;           // 24 hourly snapshots = 1 day of point-in-time recovery
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
}

async function runBackup(db) {
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

function start(db) {
  // Run immediately on startup, then every hour
  runBackup(db);
  setInterval(() => runBackup(db), INTERVAL_MS);
}

module.exports = { start, runBackup };
