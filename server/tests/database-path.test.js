const path = require('path');
const { getDatasetName, getDatabasePath } = require('../database-path');

describe('database dataset selection', () => {
  const serverDir = path.join('/tmp', 'print-farm-manager', 'server');

  test('defaults to the organic database', () => {
    expect(getDatasetName({})).toBe('organic');
    expect(getDatabasePath({}, serverDir)).toBe(
      path.join(serverDir, 'data', 'organic-data.db')
    );
  });

  test('selects the seed database explicitly', () => {
    const env = { PFM_DATASET: 'seed' };
    expect(getDatasetName(env)).toBe('seed');
    expect(getDatabasePath(env, serverDir)).toBe(
      path.join(serverDir, 'data', 'seed-data.db')
    );
  });

  test('rejects unknown dataset names', () => {
    expect(() => getDatasetName({ PFM_DATASET: 'production' }))
      .toThrow('PFM_DATASET must be "organic" or "seed"');
  });
});
