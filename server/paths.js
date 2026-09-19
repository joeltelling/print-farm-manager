// Where the server keeps its data, resolved once from the environment. Every module that
// touches the database file, uploaded G-code, backups, or the built client goes through here,
// so a caller (the test suite, a smoke test, or an operator who wants their data elsewhere)
// can point them all at another location with three variables, without patching code.
//
//   PFM_DATA_DIR    database, backups, restore uploads   (default: server/data)
//   PFM_GCODE_DIR   uploaded G-code and 3mf files        (default: server/gcode)
//   PFM_CLIENT_DIST the built React client               (default: client/dist)
//
// The defaults are exactly the paths the server has always used, so Docker volumes
// (/app/server/data, /app/server/gcode), PM2 and update.bat are unaffected.
//
// Under Jest the defaults are refused. Some modules (server/events.js, for one) open the real
// database when they are merely required, independent of the in-memory database a test builds,
// so a test that reached the default location would write fake events into the operator's
// real printer history. The suite points these variables at a throwaway directory instead
// (jest.config.js and server/tests/setup/), and this guard makes a future leak fail loudly.
const path = require('path');

function fromEnv(name, fallback) {
  const value = process.env[name];
  return value ? path.resolve(value) : fallback;
}

const dataDir    = fromEnv('PFM_DATA_DIR',    path.join(__dirname, 'data'));
const gcodeDir   = fromEnv('PFM_GCODE_DIR',   path.join(__dirname, 'gcode'));
const clientDist = fromEnv('PFM_CLIENT_DIST', path.join(__dirname, '..', 'client', 'dist'));

if (process.env.JEST_WORKER_ID !== undefined && (!process.env.PFM_DATA_DIR || !process.env.PFM_GCODE_DIR)) {
  throw new Error(
    'Refusing to use the real server/data or server/gcode directory from inside a Jest test. ' +
    'Run tests through `npm test` (jest.config.js isolates them), or set PFM_DATA_DIR and ' +
    'PFM_GCODE_DIR to a scratch directory.'
  );
}

module.exports = {
  dataDir,
  gcodeDir,
  clientDist,
  backupDir: path.join(dataDir, 'backups'),
};
