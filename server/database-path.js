const path = require('path');

const DATASET_FILES = Object.freeze({
  organic: 'organic-data.db',
  seed: 'seed-data.db',
});

function getDatasetName(env = process.env) {
  const dataset = env.PFM_DATASET || 'organic';
  if (!Object.hasOwn(DATASET_FILES, dataset)) {
    throw new Error(`PFM_DATASET must be "organic" or "seed", received "${dataset}"`);
  }
  return dataset;
}

function getDatabasePath(env = process.env, serverDir = __dirname) {
  const dataset = getDatasetName(env);
  return path.join(serverDir, 'data', DATASET_FILES[dataset]);
}

module.exports = { DATASET_FILES, getDatasetName, getDatabasePath };
