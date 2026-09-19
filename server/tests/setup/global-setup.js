// Runs once, before any test worker starts: makes the scratch root that every test file's
// private data and G-code directories live under. Workers inherit this environment variable.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async () => {
  process.env.PFM_TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-jest-'));
};
