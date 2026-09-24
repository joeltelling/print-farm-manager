// Structural guard for the part quantity ledger.
//
// Every change to parts.completed_qty must go through partLedger.adjustPartQty() so it
// lands in the audit trail. Some of those paths (set-ready in server/index.js) live
// inside the server entry point and cannot be driven from a unit test without the
// heavyweight import CLAUDE.md forbids, so this test enforces the rule at the source
// level instead: it fails if any server file other than partLedger.js contains an
// UPDATE that assigns completed_qty.
//
// If this fails, route the new write through adjustPartQty (pick the SOURCES value that
// describes the real-world event) rather than adding the file to the allow list.

const fs   = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');

// Files allowed to write completed_qty directly.
//   partLedger.js  the ledger itself
//   seed-demo.js   builds a throwaway demo DB from scratch (INSERTs, then the ledger
//                  is rebuilt on the next server start)
const ALLOWED = new Set(['partLedger.js', 'seed-demo.js'].map(f => path.join(SERVER_DIR, f)));

// UPDATE parts SET ... completed_qty = ... within a single SQL string literal.
const DIRECT_WRITE = /UPDATE\s+parts\s+SET[^`'";]*?\bcompleted_qty\s*=/gi;

function serverSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'tests', 'data', 'gcode'].includes(entry.name)) continue;
      out.push(...serverSourceFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

test('the pattern catches the forms of direct write the codebase has used', () => {
  const samples = [
    'UPDATE parts SET completed_qty = completed_qty + ?, updated_at = ? WHERE id = ?',
    'UPDATE parts SET completed_qty = MAX(0, completed_qty - ?), updated_at = ? WHERE id = ?',
    `UPDATE parts
      SET name          = COALESCE(?, name),
          completed_qty = COALESCE(?, completed_qty),
          status        = ?`,
  ];
  for (const s of samples) {
    DIRECT_WRITE.lastIndex = 0;
    expect(DIRECT_WRITE.test(s)).toBe(true);
  }
  DIRECT_WRITE.lastIndex = 0;
  expect(DIRECT_WRITE.test("UPDATE parts SET status = 'closed', updated_at = ? WHERE id = ?")).toBe(false);
});

test('no server file outside partLedger.js writes parts.completed_qty directly', () => {
  const offenders = [];
  for (const file of serverSourceFiles(SERVER_DIR)) {
    if (ALLOWED.has(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(DIRECT_WRITE)) {
      const line = src.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(SERVER_DIR, file)}:${line}`);
    }
  }
  expect(offenders).toEqual([]);
});
