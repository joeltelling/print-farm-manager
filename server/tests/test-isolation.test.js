const fs = require('fs');
const os = require('os');
const path = require('path');

// Guards the isolation set up by jest.config.js and server/tests/setup/. Before it existed,
// server/events.js opened the REAL database when merely required, so running `npm test` on a
// machine with real printers inserted fake "Job Failed", "decommission" and "Material: (none)"
// events for them (events are never deleted), and the upload route tests left fixture files in
// the real G-code folder. These tests fail if any of that could happen again.
const realDataDir = path.join(__dirname, '..', 'data');
const realGcodeDir = path.join(__dirname, '..', 'gcode');
const insideTestRoot = (p) => path.resolve(p).startsWith(path.resolve(process.env.PFM_TEST_ROOT) + path.sep);

describe('test isolation', () => {
  it('runs under a scratch root, never the real data locations', () => {
    expect(process.env.PFM_TEST_ROOT).toBeTruthy();
    expect(insideTestRoot(process.env.PFM_TEST_ROOT)).toBe(false); // the root itself is the boundary
    expect(path.resolve(process.env.PFM_TEST_ROOT).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(insideTestRoot(process.env.PFM_DATA_DIR)).toBe(true);
    expect(insideTestRoot(process.env.PFM_GCODE_DIR)).toBe(true);
  });

  it('server/paths.js resolves to those scratch directories, not the real ones', () => {
    const paths = require('../paths');
    expect(paths.dataDir).not.toBe(realDataDir);
    expect(paths.gcodeDir).not.toBe(realGcodeDir);
    expect(insideTestRoot(paths.dataDir)).toBe(true);
    expect(insideTestRoot(paths.gcodeDir)).toBe(true);
    expect(insideTestRoot(paths.backupDir)).toBe(true);
  });

  it('a module that opens the database on require (server/events.js) opens the scratch one', () => {
    const db = require('../db');
    expect(insideTestRoot(db.name)).toBe(true);
    expect(path.resolve(db.name).startsWith(realDataDir + path.sep)).toBe(false);

    const events = require('../events');
    events.insert(999, 'note', 'written by test-isolation.test.js');
    const row = db.prepare("SELECT printer_id, note FROM printer_events WHERE printer_id = 999").get();
    expect(row.note).toBe('written by test-isolation.test.js');
  });

  it('upload routes write into the scratch G-code directory', () => {
    const { gcodeDir } = require('../paths');
    fs.writeFileSync(path.join(gcodeDir, 'probe.gcode'), 'G1 X1');
    expect(fs.existsSync(path.join(process.env.PFM_GCODE_DIR, 'probe.gcode'))).toBe(true);
    expect(fs.existsSync(path.join(realGcodeDir, 'probe.gcode'))).toBe(false);
  });

  it('refuses the real directories when Jest is running without the isolation variables', () => {
    const saved = { d: process.env.PFM_DATA_DIR, g: process.env.PFM_GCODE_DIR };
    delete process.env.PFM_DATA_DIR;
    delete process.env.PFM_GCODE_DIR;
    try {
      jest.isolateModules(() => {
        expect(() => require('../paths')).toThrow(/Refusing to use the real server\/data/);
      });
    } finally {
      process.env.PFM_DATA_DIR = saved.d;
      process.env.PFM_GCODE_DIR = saved.g;
    }
  });

  it('honors the environment variables outside Jest (an operator can move their data)', () => {
    const { execFileSync } = require('child_process');
    const env = { ...process.env, PFM_DATA_DIR: '/srv/pfm/data', PFM_GCODE_DIR: '/srv/pfm/gcode', PFM_CLIENT_DIST: '/srv/pfm/dist' };
    delete env.JEST_WORKER_ID;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./server/paths')))"], { cwd: path.join(__dirname, '..', '..'), env }).toString());
    expect(out.dataDir).toBe(path.resolve('/srv/pfm/data'));
    expect(out.gcodeDir).toBe(path.resolve('/srv/pfm/gcode'));
    expect(out.clientDist).toBe(path.resolve('/srv/pfm/dist'));
    expect(out.backupDir).toBe(path.join(path.resolve('/srv/pfm/data'), 'backups'));
  });

  it('keeps the defaults exactly as before when nothing is set (Docker, PM2, update.bat)', () => {
    const { execFileSync } = require('child_process');
    const env = { ...process.env };
    for (const k of ['JEST_WORKER_ID', 'PFM_DATA_DIR', 'PFM_GCODE_DIR', 'PFM_CLIENT_DIST']) delete env[k];
    const out = JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./server/paths')))"], { cwd: path.join(__dirname, '..', '..'), env }).toString());
    expect(out.dataDir).toBe(realDataDir);
    expect(out.gcodeDir).toBe(realGcodeDir);
    expect(out.clientDist).toBe(path.join(__dirname, '..', '..', 'client', 'dist'));
  });
});
