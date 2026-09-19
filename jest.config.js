// Jest config for the server suite (`npm run test:server`).
//
// Every test file gets its own throwaway data and G-code directory, because some server
// modules open the real database or write to the real G-code folder merely by being required
// (server/events.js, the upload routes). Without this, `npm test` on a machine that has real
// printers would attach fake events to them. See server/paths.js and server/tests/setup/.
module.exports = {
  globalSetup: '<rootDir>/server/tests/setup/global-setup.js',
  globalTeardown: '<rootDir>/server/tests/setup/global-teardown.js',
  setupFilesAfterEnv: ['<rootDir>/server/tests/setup/isolate-data.js'],
};
