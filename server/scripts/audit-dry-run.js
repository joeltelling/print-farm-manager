// Part audit trail: dry run and reconciliation check.
//
// Dry run (default): snapshots the live farm DB with SQLite's online backup API (safe
// while the server is running), runs the one-time ledger rebuild against the SNAPSHOT
// only, and reports what the audit trail will look like after the upgrade. The live DB
// is opened read-only and never modified.
//
//   node server/scripts/audit-dry-run.js
//   node server/scripts/audit-dry-run.js --db C:\path\to\farm-copy.db   (rebuild a copy you made)
//   node server/scripts/audit-dry-run.js --part 12                      (also print part 12's timeline)
//
// Check (--check): read-only reconciliation of a DB that already has the ledger (the
// live DB after deploying). Reports any part whose ledger does not add up to its
// completed_qty. Exits 1 when it finds a mismatch, 0 otherwise.
//
//   node server/scripts/audit-dry-run.js --check
//   node server/scripts/audit-dry-run.js --check --db C:\path\to\farm.db

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const partLedger = require('../partLedger');

const LIVE_DB  = path.join(__dirname, '..', 'data', 'farm.db');
const SNAP_DIR = path.join(__dirname, '..', 'data', 'audit-dry-run');

function parseArgs(argv) {
  const args = { check: false, db: null, part: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--part') args.part = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '-';
}

function hasLedger(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'part_qty_ledger'").get();
}

// Parts whose ledger does not sum to completed_qty. A part with a non-zero count and
// no ledger rows at all counts as a mismatch too.
function findMismatches(db) {
  return db.prepare(`
    SELECT p.id, p.name, pr.name AS project_name, p.completed_qty,
           COALESCE(SUM(l.delta), 0) AS ledger_sum, COUNT(l.id) AS rows
    FROM parts p
    LEFT JOIN projects pr ON pr.id = p.project_id
    LEFT JOIN part_qty_ledger l ON l.part_id = p.id
    GROUP BY p.id
    HAVING COALESCE(SUM(l.delta), 0) != COALESCE(p.completed_qty, 0)
    ORDER BY p.id
  `).all();
}

function printMismatches(mismatches) {
  if (mismatches.length === 0) {
    console.log('  Mismatches: none. Every part\'s ledger adds up to its completed count.');
    return;
  }
  console.log(`  Mismatches: ${mismatches.length} part(s) where the ledger does not add up:`);
  for (const m of mismatches) {
    console.log(`    part ${m.id} "${m.name}" (${m.project_name}): completed ${m.completed_qty}, ledger ${m.ledger_sum} (${m.rows} rows)`);
  }
}

function printTimeline(db, partId) {
  const part = db.prepare(`
    SELECT p.*, pr.name AS project_name FROM parts p
    LEFT JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?
  `).get(partId);
  if (!part) {
    console.log(`\n  Part ${partId} not found.`);
    return;
  }
  console.log(`\n  Timeline for part ${part.id} "${part.name}" (${part.project_name}), ${part.completed_qty}/${part.target_qty}:`);
  const rows = db.prepare('SELECT * FROM part_qty_ledger WHERE part_id = ? ORDER BY created_at, id').all(partId);
  if (rows.length === 0) console.log('    (no ledger rows)');
  for (const r of rows) {
    const delta = r.delta > 0 ? `+${r.delta}` : String(r.delta);
    const who = r.printer_name ? ` ${r.printer_name}` : '';
    const job = r.job_id ? ` job ${r.job_id}` : '';
    console.log(`    ${fmtTime(r.created_at).padEnd(24)} ${r.source.padEnd(17)} ${delta.padStart(5)} -> ${String(r.balance_after).padStart(5)}${who}${job}`);
  }
}

async function dryRun(args) {
  let target;
  if (args.db) {
    target = path.resolve(args.db);
    if (target === path.resolve(LIVE_DB)) {
      throw new Error('Refusing to rebuild the live farm.db. Omit --db to snapshot it automatically, or pass a copy.');
    }
    if (!fs.existsSync(target)) throw new Error(`No such file: ${target}`);
  } else {
    if (!fs.existsSync(LIVE_DB)) throw new Error(`Live DB not found at ${LIVE_DB}. Pass --db <file>.`);
    if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
    target = path.join(SNAP_DIR, `farm-snapshot-${stamp()}.db`);
    const live = new Database(LIVE_DB, { readonly: true, fileMustExist: true });
    await live.backup(target);
    live.close();
    console.log(`[audit] Snapshot of the live DB written to ${target}`);
  }

  const db = new Database(target, { fileMustExist: true });
  const alreadyHadLedger = hasLedger(db) &&
    db.prepare('SELECT COUNT(*) AS n FROM part_qty_ledger').get().n > 0;
  const before = db.prepare('SELECT id, completed_qty FROM parts').all();

  partLedger.ensureSchema(db);
  const result = partLedger.rebuildMissingLedgers(db);

  // The rebuild must never change a count. Verify it on the snapshot, not by trust.
  const changed = before.filter(p =>
    db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(p.id).completed_qty !== p.completed_qty);

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM parts) AS parts,
      (SELECT COALESCE(SUM(completed_qty), 0) FROM parts) AS completed,
      (SELECT COALESCE(SUM(delta), 0) FROM part_qty_ledger WHERE source = 'rebuilt_job') AS rebuilt_units,
      (SELECT COALESCE(SUM(delta), 0) FROM part_qty_ledger WHERE source = 'baseline' AND delta > 0) AS baseline_up,
      (SELECT COALESCE(SUM(delta), 0) FROM part_qty_ledger WHERE source = 'baseline' AND delta < 0) AS baseline_down
  `).get();

  console.log('\n[audit] Dry run results');
  if (alreadyHadLedger) console.log('  Note: this DB already had a ledger; only parts without ledger rows were rebuilt.');
  console.log(`  Parts in DB: ${totals.parts}, total completed count: ${totals.completed}`);
  console.log(`  Parts rebuilt: ${result.parts} (${result.rebuiltRows} job rows, ${result.baselineRows} baseline rows)`);
  console.log(`  Units explained by finished jobs: ${totals.rebuilt_units}`);
  console.log(`  Units in baseline rows: +${totals.baseline_up} / ${totals.baseline_down} (history the old system never recorded)`);
  console.log(`  Completed counts changed by the rebuild: ${changed.length === 0 ? 'none (as required)' : changed.map(p => p.id).join(', ')}`);
  printMismatches(findMismatches(db));

  const biggest = db.prepare(`
    SELECT l.part_id, p.name, pr.name AS project_name, l.delta, p.completed_qty
    FROM part_qty_ledger l
    JOIN parts p ON p.id = l.part_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    WHERE l.source = 'baseline'
    ORDER BY ABS(l.delta) DESC LIMIT 10
  `).all();
  if (biggest.length > 0) {
    console.log('\n  Largest baseline rows (parts whose history is least explained by job records):');
    for (const b of biggest) {
      console.log(`    part ${b.part_id} "${b.name}" (${b.project_name}): ${b.delta > 0 ? '+' : ''}${b.delta} of ${b.completed_qty}`);
    }
  }

  if (args.part) printTimeline(db, args.part);
  db.close();

  console.log(`\n[audit] Done. The snapshot at ${target} can be deleted; the live DB was not modified.`);
  return changed.length === 0 ? 0 : 1;
}

function check(args) {
  const file = path.resolve(args.db || LIVE_DB);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  console.log(`[audit] Reconciliation check (read-only) of ${file}`);
  if (!hasLedger(db)) {
    console.log('  This DB has no part ledger yet. Start the updated server once, or use the dry run.');
    db.close();
    return 1;
  }
  const mismatches = findMismatches(db);
  const counts = db.prepare(`
    SELECT source, COUNT(*) AS rows, COALESCE(SUM(delta), 0) AS units
    FROM part_qty_ledger GROUP BY source ORDER BY source
  `).all();
  console.log('  Ledger rows by source:');
  for (const c of counts) console.log(`    ${c.source.padEnd(17)} ${String(c.rows).padStart(6)} rows, ${c.units > 0 ? '+' : ''}${c.units} units`);
  printMismatches(mismatches);
  if (args.part) printTimeline(db, args.part);
  db.close();
  return mismatches.length === 0 ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const header = fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//'));
    console.log(header.map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  return args.check ? check(args) : dryRun(args);
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[audit] ${err.message}`);
    process.exit(2);
  });
