// Driver registry — maps printer.type → driver module.
// Each driver implements: getStatus, uploadAndPrint, cancelJob, checkIfPrinting.
// Add a new entry here when a new printer brand is supported.
//
// Drivers are loaded lazily (on first getDriver call for that type) so that
// optional native dependencies (e.g. sdcp → mqtt-server) are only required
// when a printer of that brand is actually present.

const LOADERS = {
  'prusa':           () => require('./prusa'),
  'elegoo-centauri': () => require('./elegoo-centauri'),
};

function getDriver(type) {
  const load = LOADERS[type];
  if (!load) throw new Error(`No driver registered for printer type: "${type}"`);
  return load();
}

module.exports = { getDriver };
