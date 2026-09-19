// Runs before each test file (after the test framework is installed, before the test file
// loads any server module). Points the server's data and G-code directories at a directory
// private to this test file, so nothing a test writes can reach the real database, the real
// upload folder, or another test file. See server/paths.js.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = process.env.PFM_TEST_ROOT || path.join(os.tmpdir(), `pfm-jest-${process.pid}`);
const id = crypto.createHash('sha1').update(expect.getState().testPath || String(process.pid)).digest('hex').slice(0, 10);
const dir = path.join(root, id);

process.env.PFM_DATA_DIR = path.join(dir, 'data');
process.env.PFM_GCODE_DIR = path.join(dir, 'gcode');
fs.mkdirSync(process.env.PFM_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.PFM_GCODE_DIR, { recursive: true });
