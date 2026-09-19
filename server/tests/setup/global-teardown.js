// Runs once, after the last test: removes everything the run wrote under the scratch root.
const fs = require('fs');

module.exports = async () => {
  const root = process.env.PFM_TEST_ROOT;
  if (root) fs.rmSync(root, { recursive: true, force: true });
};
