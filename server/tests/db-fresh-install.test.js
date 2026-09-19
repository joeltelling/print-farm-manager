const fs = require('fs');
const path = require('path');

// Route tests build an in-memory schema instead of importing server/db.js (see CLAUDE.md),
// because db.js opens a real on-disk file and runs the full startup migration chain. That is
// exactly what this file needs to exercise: a bug where a Spoolman column addition ran before
// an older gcode_id-nullable rebuild migration broke that rebuild on every fresh install
// (a brand-new database always has gcode_id NOT NULL, so the rebuild always fires).
// Copying db.js (and the paths.js it reads) into its own scratch directory, with the data
// directory pointed at a fresh folder there, keeps this isolated from every other test's
// expectations while still requiring the real migration code.
describe('server/db.js: fresh-install migration ordering', () => {
  const scratchDir = path.join(__dirname, '.tmp-fresh-install');
  let db;

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  test('a brand-new database ends up with a nullable gcode_id and the spoolman columns on jobs', () => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'db.js'), path.join(scratchDir, 'db.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'paths.js'), path.join(scratchDir, 'paths.js'));
    // a brand-new, empty data directory: this is the fresh-install case
    process.env.PFM_DATA_DIR = path.join(scratchDir, 'data');
    process.env.PFM_GCODE_DIR = path.join(scratchDir, 'gcode');

    db = require(path.join(scratchDir, 'db.js'));

    const cols = db.prepare("PRAGMA table_info(jobs)").all();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));

    expect(byName.gcode_id.notnull).toBe(0);
    expect(byName.spoolman_spool_id).toBeDefined();
    expect(byName.spoolman_reported_at).toBeDefined();
    expect(cols).toHaveLength(11);
  });
});
